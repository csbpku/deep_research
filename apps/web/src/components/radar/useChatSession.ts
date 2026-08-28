'use client';

// Chat session lifecycle hook — owns POST /api/chat/sessions and the
// send-message POST/SSE flow. Both the AskAiDrawer (Sheet wrapper) and
// the radar floating BottomSheet consume this hook; the presentational
// surface is in `ChatPanel.tsx`. Streaming is supported via SSE with
// the polling POST as a transparent fallback when SSE is unavailable.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  latencyMs?: number | null;
  /** M7: 引用锚点。[[cite]]...[[/cite]] quotes parsed by ai-engine. */
  sources?: Array<{ quote?: string; sourceBlockIndex?: number | string; location?: string; sourcePath?: string; sourceUrl?: string; anchorId?: string }> | null;
}

export interface ChatSeedSnapshot {
  id: string;
  title: string;
  url: string;
  body: string;
  interpretation: string | null;
  summaryDate: string;
  tags: string[];
  authors: string[];
  originalMarkdown: string | null;
  originalKind: string | null;
  readingContext: string | null;
}

export interface ChatSession {
  sessionId: string;
  status: string;
  seedSnapshot: ChatSeedSnapshot;
  messages: ChatMessage[];
}

export interface Anchor {
  quote: string;
  startOffset: number;
  endOffset: number;
  contextByScope?: Partial<Record<ContextScope, string>>;
}

export type ContextScope = 'selection' | 'paragraph' | 'section' | 'full' | 'project';

// Transport guard only. The article context is not constrained by this value.
const MAX_INPUT_CHARS = 32000;

const THINKING_STEP_MS: ReadonlyArray<number> = [900, 1900];
const TYPEWRITER_INTERVAL_MS = 16;
const TYPEWRITER_CHARS_PER_TICK = 12;
const SLOW_GENERATION_MS = 12000;

export interface UseChatSessionOptions {
  summaryId: string;
  /** When false, the session is suspended (e.g. the parent sheet is closed). */
  enabled: boolean;
  /**
   * Called whenever a new assistant message finishes persisting
   * (either via SSE `done` or via the polling POST return). Useful for
   * parent components that want to track unread count.
   */
  onAssistantMessage?: (message: ChatMessage) => void;
  /**
   * Called when the SSE stream falls back to polling. Default: log to
   * console. Parent can use this to surface a "stream unavailable" hint.
   */
  onStreamFallback?: () => void;
}

export interface UseChatSessionResult {
  session: ChatSession | null;
  loading: boolean;
  sending: boolean;
  slowGeneration: boolean;
  thinkingStep: number;
  err: string | null;
  input: string;
  setInput: (value: string) => void;
  sendMessage: (content: string, anchor?: Anchor | null) => Promise<void>;
  stopGeneration: () => void;
  contextScope: ContextScope;
  setContextScope: (scope: ContextScope) => void;
  retryLoad: () => void;
  messagesRef: React.RefObject<HTMLDivElement | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function useChatSession({
  summaryId,
  enabled,
  onAssistantMessage,
  onStreamFallback,
}: UseChatSessionOptions): UseChatSessionResult {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [slowGeneration, setSlowGeneration] = useState(false);
  const [thinkingStep, setThinkingStep] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [contextScope, setContextScope] = useState<ContextScope>('full');

  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const loadRef = useRef<{ summaryId: string; promise: Promise<ChatSession> } | null>(null);
  const typewriterQueueRef = useRef('');
  const typewriterTimerRef = useRef<number | null>(null);
  const typewriterWaitersRef = useRef<Array<() => void>>([]);
  const slowTimerRef = useRef<number | null>(null);
  const firstDeltaAtRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const typewriterControlRef = useRef<{ stop: () => void } | null>(null);

  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (slowTimerRef.current !== null) {
      window.clearTimeout(slowTimerRef.current);
    }
    if (typewriterTimerRef.current !== null) {
      window.clearTimeout(typewriterTimerRef.current);
    }
    typewriterQueueRef.current = '';
    const waiters = typewriterWaitersRef.current.splice(0);
    waiters.forEach((resolve) => resolve());
  }, []);

  // Load session on enable / summary change
  useEffect(() => {
    if (!enabled || !summaryId) return;
    if (!loadRef.current || loadRef.current.summaryId !== summaryId) {
      loadRef.current = { summaryId, promise: createAndLoadSession(summaryId) };
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void loadRef.current.promise
      .then((sessionData) => {
        if (!cancelled) setSession(sessionData);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setErr(loadError instanceof Error ? loadError.message : '加载失败');
          loadRef.current = null;
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, summaryId, retryCount]);

  // Thinking-step progression while waiting
  useEffect(() => {
    if (!sending) {
      setThinkingStep(0);
      return;
    }
    const timers = THINKING_STEP_MS.map((ms, i) =>
      window.setTimeout(() => setThinkingStep(i + 1), ms),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [sending]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [session?.messages.length, sending]);

  const retryLoad = useCallback(() => {
    loadRef.current = null;
    setSession(null);
    setRetryCount((c) => c + 1);
  }, []);

  const sendMessage = useCallback(
    async (rawContent: string, anchor?: Anchor | null) => {
      const trimmed = rawContent.trim();
      if (!trimmed || !session || sending) return;
      if (trimmed.length > MAX_INPUT_CHARS) {
        setErr(`提问最多 ${MAX_INPUT_CHARS} 字`);
        return;
      }
      setSending(true);
      setErr(null);

      const optimisticUserId = `optimistic-${Date.now()}`;
      const streamingAssistantId = `streaming-${Date.now()}`;
      const optimisticUserMsg: ChatMessage = {
        id: optimisticUserId,
        role: 'user',
        content: trimmed,
        createdAt: new Date().toISOString(),
      };
      const streamingPlaceholder: ChatMessage = {
        id: streamingAssistantId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
        sources: null,
        latencyMs: null,
      };
      setSession((prev) =>
        prev ? { ...prev, messages: [...prev.messages, optimisticUserMsg, streamingPlaceholder] } : prev,
      );
      setInput('');

      const stopTypewriter = () => {
        if (typewriterTimerRef.current !== null) {
          window.clearTimeout(typewriterTimerRef.current);
          typewriterTimerRef.current = null;
        }
        typewriterQueueRef.current = '';
        const waiters = typewriterWaitersRef.current.splice(0);
        waiters.forEach((resolve) => resolve());
      };
      const clearSlowTimer = () => {
        if (slowTimerRef.current !== null) {
          window.clearTimeout(slowTimerRef.current);
          slowTimerRef.current = null;
        }
        setSlowGeneration(false);
      };
      typewriterControlRef.current = { stop: stopTypewriter };
      firstDeltaAtRef.current = null;
      setSlowGeneration(false);
      slowTimerRef.current = window.setTimeout(() => {
        slowTimerRef.current = null;
        if (firstDeltaAtRef.current === null) {
          setSlowGeneration(true);
        }
      }, SLOW_GENERATION_MS);
      const controller = new AbortController();
      abortRef.current = controller;
      const resolveTypewriterWaiters = () => {
        const waiters = typewriterWaitersRef.current.splice(0);
        waiters.forEach((resolve) => resolve());
      };
      const scheduleTypewriter = () => {
        if (typewriterTimerRef.current !== null) return;
        typewriterTimerRef.current = window.setTimeout(() => {
          typewriterTimerRef.current = null;
          const visibleChunk = typewriterQueueRef.current.slice(0, TYPEWRITER_CHARS_PER_TICK);
          typewriterQueueRef.current = typewriterQueueRef.current.slice(visibleChunk.length);
          if (visibleChunk) {
            setSession((prev) =>
              prev
                ? {
                    ...prev,
                    messages: prev.messages.map((m) =>
                      m.id === streamingAssistantId ? { ...m, content: m.content + visibleChunk } : m,
                    ),
                  }
                : prev,
            );
          }
          if (typewriterQueueRef.current) {
            scheduleTypewriter();
          } else {
            resolveTypewriterWaiters();
          }
        }, TYPEWRITER_INTERVAL_MS);
      };
      const enqueueTypewriterText = (chunk: string) => {
        typewriterQueueRef.current += chunk;
        scheduleTypewriter();
      };
      const drainTypewriter = () => {
        if (!typewriterQueueRef.current) return Promise.resolve();
        return new Promise<void>((resolve) => {
          typewriterWaitersRef.current.push(resolve);
          scheduleTypewriter();
        });
      };

      // Try SSE first; fall back to polling POST if SSE is unavailable.
      const streamAttempt = await tryStreamChat(
        session.sessionId,
        trimmed,
        anchor,
        contextScope,
        {
          onDelta: (chunk) => {
            firstDeltaAtRef.current = Date.now();
            clearSlowTimer();
            enqueueTypewriterText(chunk);
          },
          onCitations: (sources) => {
            setSession((prev) =>
              prev
                ? {
                    ...prev,
                    messages: prev.messages.map((m) =>
                      m.id === streamingAssistantId ? { ...m, sources } : m,
                    ),
                  }
                : prev,
            );
          },
          onDone: async (finalMsg) => {
            await drainTypewriter();
            clearSlowTimer();
            const persisted: ChatMessage = {
              id: finalMsg.id,
              role: 'assistant',
              content: finalMsg.content,
              createdAt: finalMsg.createdAt,
              latencyMs: finalMsg.latencyMs ?? null,
              sources: finalMsg.sources ?? null,
            };
            setSession((prev) =>
              prev
                ? {
                    ...prev,
                    messages: prev.messages.map((m) => (m.id === streamingAssistantId ? persisted : m)),
                  }
                : prev,
            );
            onAssistantMessage?.(persisted);
          },
        },
        controller.signal,
      ).catch(() => null);

      if (streamAttempt === 'aborted') {
        stopTypewriter();
        clearSlowTimer();
        abortRef.current = null;
        setSession((prev) =>
          prev
            ? {
                ...prev,
                messages: prev.messages.filter(
                  (m) => m.id !== streamingAssistantId && m.id !== optimisticUserId,
                ),
              }
            : prev,
        );
        setInput(trimmed);
        setSending(false);
        textareaRef.current?.focus();
        return;
      }

      if (streamAttempt === 'streamed') {
        await drainTypewriter();
        clearSlowTimer();
        abortRef.current = null;
        setSending(false);
        textareaRef.current?.focus();
        return;
      }

      // Fallback: polling POST. Roll back the streaming placeholder first.
      stopTypewriter();
      setSession((prev) =>
        prev
          ? { ...prev, messages: prev.messages.filter((m) => m.id !== streamingAssistantId) }
          : prev,
      );
      if (streamAttempt === 'unsupported') {
        onStreamFallback?.();
      }
      try {
        const body: Record<string, unknown> = { content: trimmed };
        if (anchor?.quote) {
          body.anchor = {
            quote: anchor.quote,
            startOffset: anchor.startOffset,
            endOffset: anchor.endOffset,
            contextScope,
            contextText: anchor.contextByScope?.[contextScope],
          };
        }
        const res = await fetch(`/api/chat/sessions/${session.sessionId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            message?: string;
            details?: { fieldErrors?: Record<string, string[]> };
          };
          const fieldError = errBody.details?.fieldErrors
            ? Object.values(errBody.details.fieldErrors).flat()[0]
            : undefined;
          throw new Error(fieldError ?? errBody.message ?? '发送失败');
        }
        const reply = (await res.json()) as ChatMessage;
        setSession((prev) =>
          prev ? { ...prev, messages: [...prev.messages, reply] } : prev,
        );
        onAssistantMessage?.(reply);
      } catch (error) {
        if (isAbortError(error)) {
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  messages: prev.messages.filter(
                    (m) => m.id !== streamingAssistantId && m.id !== optimisticUserId,
                  ),
                }
              : prev,
          );
          setInput(trimmed);
          return;
        }
        setErr(error instanceof Error ? error.message : String(error));
        setSession((prev) =>
          prev
            ? { ...prev, messages: prev.messages.filter((m) => m.id !== optimisticUserId) }
            : prev,
        );
      } finally {
        clearSlowTimer();
        abortRef.current = null;
        setSending(false);
        textareaRef.current?.focus();
      }
    },
    [contextScope, session, sending, onAssistantMessage, onStreamFallback],
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    firstDeltaAtRef.current = null;
    if (slowTimerRef.current !== null) {
      window.clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
    setSlowGeneration(false);
    typewriterControlRef.current?.stop();
  }, []);

  return {
    session,
    loading,
    sending,
    slowGeneration,
    thinkingStep,
    err,
    input,
    setInput,
    sendMessage,
    stopGeneration,
    contextScope,
    setContextScope,
    retryLoad,
    messagesRef,
    textareaRef,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Wire: session create + load
// ─────────────────────────────────────────────────────────────────────

async function createAndLoadSession(summaryId: string): Promise<ChatSession> {
  const createRes = await fetch('/api/chat/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seedSummaryId: summaryId }),
  });
  if (!createRes.ok) {
    const body = (await createRes.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? '创建会话失败');
  }
  const createData = (await createRes.json()) as { sessionId: string };
  const getRes = await fetch(`/api/chat/sessions/${createData.sessionId}`, { cache: 'no-store' });
  if (!getRes.ok) {
    const body = (await getRes.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? '加载历史失败');
  }
  return (await getRes.json()) as ChatSession;
}

// ─────────────────────────────────────────────────────────────────────
// Wire: SSE streaming consumer
// ─────────────────────────────────────────────────────────────────────

interface StreamCallbacks {
  onDelta: (chunk: string) => void;
  onCitations: (sources: Array<{ quote?: string; sourceBlockIndex?: number | string; location?: string; sourcePath?: string; sourceUrl?: string; anchorId?: string }>) => void;
  onDone: (finalMsg: {
    id: string;
    content: string;
    createdAt: string;
    latencyMs?: number | null;
    sources?: Array<{ quote?: string; sourceBlockIndex?: number | string; location?: string; sourcePath?: string; sourceUrl?: string; anchorId?: string }> | null;
  }) => void | Promise<void>;
}

type StreamOutcome = 'streamed' | 'unsupported' | 'error' | 'aborted';

/**
 * Try the SSE endpoint. Returns:
 *   - 'streamed' on success (all callbacks ran, no error)
 *   - 'unsupported' when the route returned 404 or non-SSE (fall back to polling)
 *   - 'error' on transport error
 */
async function tryStreamChat(
  sessionId: string,
  content: string,
  anchor: Anchor | null | undefined,
  contextScope: ContextScope,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<StreamOutcome> {
  let res: Response;
  try {
    const body: Record<string, unknown> = { content };
    if (anchor?.quote) {
      body.anchor = {
        quote: anchor.quote,
        startOffset: anchor.startOffset,
        endOffset: anchor.endOffset,
        contextScope,
        contextText: anchor.contextByScope?.[contextScope],
      };
    }
    res = await fetch(`/api/chat/sessions/${sessionId}/messages/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    return isAbortError(error) ? 'aborted' : 'error';
  }
  // 404 means the streaming endpoint isn't deployed (older ai-engine);
  // 5xx means the engine is unavailable. Both fall back to polling.
  if (!res.ok || !res.body) {
    return 'unsupported';
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('text/event-stream')) {
    return 'unsupported';
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseFrame(frame);
        if (!parsed) continue;
        if (parsed.event === 'delta') {
          try {
            const chunk = JSON.parse(parsed.data) as string;
            if (typeof chunk === 'string') callbacks.onDelta(chunk);
          } catch {
            // tolerate partial JSON
          }
        } else if (parsed.event === 'citations') {
          try {
            const payload = JSON.parse(parsed.data) as { citations: Array<{ quote?: string; sourceBlockIndex?: number | string; location?: string; sourcePath?: string; sourceUrl?: string; anchorId?: string }> };
            callbacks.onCitations(payload.citations ?? []);
          } catch {
            // ignore
          }
        } else if (parsed.event === 'done') {
          try {
            const payload = JSON.parse(parsed.data) as {
              message_id: string;
              content: string;
              created_at: string;
              latency_ms?: number | null;
              sources?: Array<{ quote?: string; sourceBlockIndex?: number | string; location?: string; sourcePath?: string; sourceUrl?: string; anchorId?: string }> | null;
            };
            await callbacks.onDone({
              id: payload.message_id,
              content: payload.content,
              createdAt: payload.created_at,
              latencyMs: payload.latency_ms ?? null,
              sources: payload.sources ?? null,
            });
          } catch {
            // ignore
          }
          return 'streamed';
        } else if (parsed.event === 'error') {
          try {
            const payload = JSON.parse(parsed.data) as { message?: string };
            throw new Error(payload.message ?? 'AI 暂时没有生成回答');
          } catch (innerError) {
            if (innerError instanceof Error) throw innerError;
            throw new Error('AI 暂时没有生成回答');
          }
        }
      }
    }
    return 'streamed';
  } catch (error) {
    return isAbortError(error) ? 'aborted' : 'error';
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}

interface ParsedFrame {
  event: string;
  data: string;
}

function parseSseFrame(frame: string): ParsedFrame | null {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // SSE allows multiple data: lines; concatenate them.
      const part = line.slice(5).trimStart();
      data = data ? `${data}\n${part}` : part;
    }
  }
  if (!data) return null;
  return { event, data };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError')
    || (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
  );
}
