'use client';

// AI followup drawer — slide-in panel anchored to a radar candidate / summary.
// Posts to /api/chat/sessions + /api/chat/sessions/{id}/messages.
//
// Visual contract (mockup lines 485-606):
// - 480px right drawer, slide-in
// - Header: title, ↗ 看原文, ×
// - Context strip
// - 4 suggestion chips
// - Chat history (user/assistant bubbles)
// - Footer textarea + send button (⌘+Enter)

import { useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  FileText,
  Lightbulb,
  Link2,
  Paperclip,
  Send,
  Sparkles,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
} from '@/components/ui/sheet';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  latencyMs?: number | null;
}

interface ChatSession {
  sessionId: string;
  status: string;
  seedSnapshot: {
    id: string;
    title: string;
    url: string;
    body: string;
    interpretation: string | null;
    summaryDate: string;
    tags: string[];
    // Phase 1 deep-dive: original source captured by radar sync. Null
    // for pre-Phase-0 rows.
    originalMarkdown: string | null;
    originalKind: string | null;
  };
  messages: ChatMessage[];
}

const SUGGESTIONS = [
  '这篇的核心观点是什么？',
  '和我们项目有什么关联？',
  '作者没提到什么？',
  '用 50 人的话能落地吗？',
];

interface Props {
  summaryId: string;
  summaryTitle: string;
  summaryUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

async function createAndLoadSession(summaryId: string): Promise<ChatSession> {
  const createRes = await fetch('/api/chat/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seedSummaryId: summaryId }),
  });
  if (!createRes.ok) {
    const body = await createRes.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? '创建会话失败');
  }

  const createData = await createRes.json() as { sessionId: string };
  const getRes = await fetch(`/api/chat/sessions/${createData.sessionId}`, { cache: 'no-store' });
  if (!getRes.ok) {
    const body = await getRes.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? '加载历史失败');
  }
  return await getRes.json() as ChatSession;
}

export function AskAiDrawer({
  summaryId,
  summaryTitle,
  summaryUrl,
  open,
  onOpenChange,
}: Props) {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const loadRef = useRef<{ summaryId: string; promise: Promise<ChatSession> } | null>(null);

  useEffect(() => {
    if (!open || !summaryId) return;
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
  }, [open, summaryId]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [session?.messages.length, sending]);

  function close() {
    onOpenChange(false);
    setTimeout(() => {
      loadRef.current = null;
      setSession(null);
      setInput('');
    }, 300);
  }

  async function sendMessage(content: string, anchor?: { quote: string; startOffset: number; endOffset: number } | null) {
    const trimmed = content.trim();
    if (!trimmed || !session || sending) return;
    setSending(true);
    setErr(null);
    const optimisticUserMsg: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
    };
    setSession({
      ...session,
      messages: [...session.messages, optimisticUserMsg],
    });
    setInput('');
    try {
      // Phase 3.b: attach anchor if user selected text before asking
      const body: Record<string, unknown> = { content: trimmed };
      if (anchor?.quote) {
        body.anchor = {
          quote: anchor.quote,
          startOffset: anchor.startOffset,
          endOffset: anchor.endOffset,
        };
      }
      const res = await fetch(`/api/chat/sessions/${session.sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? '发送失败');
      }
      const reply = (await res.json()) as ChatMessage;
      setSession((prev) =>
        prev ? { ...prev, messages: [...prev.messages, reply] } : prev
      );
    } catch (e2) {
      setErr(String((e2 as Error).message ?? '发送失败'));
      // Roll back optimistic user message
      setSession((prev) =>
        prev
          ? { ...prev, messages: prev.messages.filter((m) => m.id !== optimisticUserMsg.id) }
          : prev
      );
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void sendMessage(input, null);
    }
  }


  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col p-0 sm:max-w-md"
      >
        {/* Header */}
        <SheetHeader>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span
              className="truncate text-sm font-medium"
              title={summaryTitle}
            >
              {summaryTitle}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button asChild variant="link" size="xs" className="h-auto p-0 text-method-ai">
              <a href={summaryUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-3" />
                看原文
              </a>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={close}
              aria-label="关闭"
            >
              <X className="size-4" />
            </Button>
          </div>
        </SheetHeader>

        {/* Context strip */}
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          <Sparkles className="size-3 text-method-ai" />
          <span>
            {session?.seedSnapshot.originalMarkdown
              ? 'AI 上下文：原文 + 解读 + 摘要'
              : 'AI 上下文：原文 + interpretation'}
          </span>
        </div>

        {/* Suggestion chips */}
        <div className="border-b border-border px-4 py-3">
          <div className="mb-1.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Lightbulb className="size-3" />
            试试这些问题
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <Button
                key={s}
                type="button"
                variant="outline"
                size="xs"
                className="rounded-full"
                disabled={sending || !session}
                onClick={() => void sendMessage(s, null)}
              >
                {s}
              </Button>
            ))}
          </div>
        </div>

        {/* Messages */}
        <div ref={messagesRef} className="flex-1 overflow-y-auto bg-card px-4 py-4">
          {loading ? (
            <div className="py-4 text-center text-sm text-muted-foreground">加载会话中…</div>
          ) : err ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {err}
            </div>
          ) : (
            <>
              {session && session.messages.length === 0 ? (
                <div className="mb-3 flex gap-3">
                  <div
                    aria-hidden
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-method-ai text-xs text-primary-foreground"
                  >
                    <Sparkles className="size-3.5" />
                  </div>
                  <div className="text-sm leading-relaxed text-muted-foreground">
                    我已读了原文和 AI 摘要。想了解什么？
                    <div className="mt-1 text-[11px]">可以引用文章中的具体段落，或直接发问。</div>
                  </div>
                </div>
              ) : null}

              {(session?.messages ?? []).map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="mb-2 flex justify-end">
                    <div className="max-w-[78%] rounded-2xl rounded-tl-md bg-muted px-3.5 py-2 text-sm whitespace-pre-wrap break-words">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="mb-3 flex gap-3">
                    <div
                      aria-hidden
                      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-method-ai text-xs text-primary-foreground"
                    >
                      <Sparkles className="size-3.5" />
                    </div>
                    <div className="flex-1 text-sm leading-relaxed whitespace-pre-wrap break-words">
                      {m.content}
                      {m.latencyMs ? (
                        <div className="mt-1.5 text-[11px] text-muted-foreground">
                          {m.latencyMs < 1000
                            ? `${m.latencyMs}ms`
                            : `${(m.latencyMs / 1000).toFixed(1)}s`}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              )}

              {sending ? (
                <div className="mb-3 flex gap-3" aria-live="polite">
                  <div
                    aria-hidden
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-method-ai text-xs text-primary-foreground"
                  >
                    <Sparkles className="size-3.5" />
                  </div>
                  <div className="text-sm text-muted-foreground">
                    AI 正在思考<span className="typing-cursor">▍</span>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-border bg-card p-3">
          <div className="rounded-md border border-input focus-within:border-method-ai focus-within:ring-1 focus-within:ring-method-ai/40">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="提问… (⌘+Enter 发送)"
              rows={2}
              disabled={!session || sending}
              className="w-full resize-none border-0 bg-transparent p-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            <div className="flex items-center justify-between px-1 pb-1">
              <div className="flex gap-1 text-xs text-muted-foreground">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="附加文件（未启用）"
                  disabled
                  className="text-muted-foreground"
                >
                  <Paperclip className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label="引用（未启用）"
                  disabled
                  className="text-muted-foreground"
                >
                  <Link2 className="size-3" />
                  引用
                </Button>
              </div>
              <Button
                type="button"
                size="xs"
                disabled={!input.trim() || !session || sending}
                onClick={() => void sendMessage(input)}
              >
                <Send className="size-3.5" />
                发送
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default AskAiDrawer;
