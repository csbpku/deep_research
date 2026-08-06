'use client';

// AI followup discussion workspace — a wide reading + discussion surface
// anchored to a radar candidate / summary. It uses the Sheet primitive for
// focus management, but becomes a two-column reading workspace on desktop.
// Posts to /api/chat/sessions + /api/chat/sessions/{id}/messages.
//
// Visual contract (mockup lines 485-606):
// - Desktop: full article context on the left, discussion on the right
// - Mobile: full-screen discussion layer with a compact context strip
// - Header: title, ↗ 看原文, ×
// - 4 suggestion chips
// - Chat history (user/assistant bubbles)
// - Footer textarea + send button (⌘+Enter)

import { useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  FileText,
  Lightbulb,
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
import MarkdownContent from '@/components/MarkdownContent';

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
  '这篇文章的核心结论是什么？',
  '作者用哪些证据支持这个结论？',
  '文中提到的限制和风险有哪些？',
  '对我们团队可能有什么启发？请标注不确定性。',
];

const THINKING_STEPS = [
  '正在读取原文和摘要',
  '正在整理相关证据',
  '正在生成回答',
] as const;

interface Props {
  summaryId: string;
  summaryTitle: string;
  summaryUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contextExcerpt?: string | null;
}

const MAX_READING_CHARS = 18_000;
const CHAT_MESSAGE_LIMIT = 4000;

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
  contextExcerpt = null,
}: Props) {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [thinkingStep, setThinkingStep] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [contextExpanded, setContextExpanded] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const loadRef = useRef<{ summaryId: string; promise: Promise<ChatSession> } | null>(null);
  const readingContent = contextExcerpt ?? '';
  const readingTruncated = readingContent.length > MAX_READING_CHARS;
  const visibleReadingContent = readingTruncated
    ? `${readingContent.slice(0, MAX_READING_CHARS)}\n\n…`
    : readingContent;

  useEffect(() => {
    if (open) setContextExpanded(false);
  }, [open, summaryId]);

  useEffect(() => {
    if (!sending) {
      setThinkingStep(0);
      return;
    }
    const timers = [
      window.setTimeout(() => setThinkingStep(1), 900),
      window.setTimeout(() => setThinkingStep(2), 1900),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [sending]);

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
  }, [open, summaryId, retryCount]);

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
      setContextExpanded(false);
    }, 300);
  }

  async function sendMessage(content: string, anchor?: { quote: string; startOffset: number; endOffset: number } | null) {
    const trimmed = content.trim();
    if (!trimmed || !session || sending) return;
    if (trimmed.length > CHAT_MESSAGE_LIMIT) {
      setErr(`提问最多 ${CHAT_MESSAGE_LIMIT} 字`);
      return;
    }
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
        const body = await res.json().catch(() => ({})) as {
          message?: string;
          details?: { fieldErrors?: Record<string, string[]> };
        };
        const fieldError = body.details?.fieldErrors
          ? Object.values(body.details.fieldErrors).flat()[0]
          : undefined;
        throw new Error(fieldError ?? body.message ?? '发送失败');
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
        overlayClassName="bg-foreground/15 backdrop-blur-0"
        hideClose
        className="gap-0 overflow-hidden p-0 sm:max-w-none lg:left-1/2 lg:right-auto lg:w-[min(1120px,calc(100vw-32px))] lg:-translate-x-1/2 lg:flex-row"
      >
        {/* Desktop reading pane: the article remains visible while discussing. */}
        <div className="hidden min-h-0 min-w-0 flex-1 flex-col bg-background lg:flex">
          <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
            <div className="flex min-w-0 items-center gap-2">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">正文阅读</span>
            </div>
            <Button asChild variant="link" size="xs" className="h-auto shrink-0 p-0">
              <a href={summaryUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-3" />
                新窗口打开
              </a>
            </Button>
          </div>
          <article className="min-h-0 flex-1 overflow-y-auto px-6 py-7">
              <h2 className="text-xl font-semibold leading-tight tracking-normal">{summaryTitle}</h2>
            <MarkdownContent
              content={visibleReadingContent || '暂无正文内容。'}
              className="mt-5 text-[15px] leading-8"
            />
            <p className="mt-5 rounded-md bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
              {readingTruncated ? `正文较长，已展示前 ${MAX_READING_CHARS.toLocaleString()} 字。` : '想查看完整正文或网页排版？'}
              <a className="ml-1 font-medium text-primary hover:underline" href={summaryUrl} target="_blank" rel="noopener noreferrer">
                Read more · 继续阅读原文
              </a>
            </p>
          </article>
          <p className="shrink-0 border-t border-border px-6 py-2 text-[11px] leading-5 text-muted-foreground">
            当前显示平台提取并清洗后的正文；原文网页请使用右上角新窗口打开。
          </p>
        </div>

        {/* AI pane. Team discussion is persistent below the radar article. */}
        <div className="flex min-h-0 w-full flex-1 flex-col bg-card lg:w-[430px] lg:flex-none lg:border-l lg:border-border">
          {/* Header */}
          <SheetHeader className="flex-row items-center justify-between gap-3 pr-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Sparkles className="size-4 shrink-0 text-method-ai" aria-hidden />
              <div className="min-w-0">
                <div className="text-sm font-semibold">与 AI 讨论</div>
                <div className="truncate text-[11px] text-muted-foreground" title={summaryTitle}>
                  基于当前雷达条目
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button asChild variant="link" size="xs" className="h-auto p-0 text-method-ai lg:hidden">
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

        {/* Reading context stays visible while composing an AI question. */}
          {contextExcerpt ? (
            <div className="border-b border-border bg-accent/30 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground lg:hidden">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Sparkles className="size-3 shrink-0 text-method-ai" />
                <span className="font-medium text-foreground">正文摘录</span>
              </span>
              <button
                type="button"
                className="shrink-0 text-[11px] font-medium text-primary hover:underline"
                onClick={() => setContextExpanded((value) => !value)}
                aria-expanded={contextExpanded}
              >
                {contextExpanded ? '收起' : '展开'}
              </button>
            </div>
            <p className={`mt-1.5 whitespace-pre-wrap ${contextExpanded ? '' : 'line-clamp-3'}`}>
              {visibleReadingContent}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground/80">
              AI 只基于原文、解读和摘要回答；资料不足会明确标注推断。
            </p>
            </div>
          ) : null}

        {/* AI context state */}
          <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            <Sparkles className="size-3 text-method-ai" />
            <span>{session?.seedSnapshot.originalMarkdown ? 'AI 上下文：原文 + 解读 + 摘要' : 'AI 上下文：原文 + interpretation'}</span>
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
          <div ref={messagesRef} className="flex flex-1 flex-col overflow-y-auto bg-card px-4 py-4">
          {loading ? (
            <div className="py-4 text-center text-sm text-muted-foreground">加载会话中…</div>
          ) : err ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4" role="alert">
              <div className="text-sm font-medium text-destructive">AI 讨论暂时无法打开</div>
              <p className="mt-1 text-xs leading-5 text-destructive/80">{err}</p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="mt-3 border-destructive/30 bg-background"
                onClick={() => {
                  loadRef.current = null;
                  setSession(null);
                  setRetryCount((count) => count + 1);
                }}
              >
                重试连接
              </Button>
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
                  <div key={m.id} className="mb-4 flex justify-end pl-8">
                    <div className="max-w-[86%]">
                      <div className="mb-1 text-right text-[11px] font-medium text-muted-foreground">你</div>
                      <div className="rounded-2xl rounded-tr-md bg-primary px-3.5 py-2.5 text-sm leading-6 text-primary-foreground shadow-sm whitespace-pre-wrap break-words">
                        {m.content}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="mb-5 flex gap-2.5 pr-3">
                    <div
                      aria-hidden
                      className="mt-5 flex size-7 shrink-0 items-center justify-center rounded-full bg-method-ai text-xs text-primary-foreground shadow-sm"
                    >
                      <Sparkles className="size-3.5" />
                    </div>
                    <div className="min-w-0 max-w-[92%]">
                      <div className="mb-1 text-[11px] font-medium text-method-ai">AI 助手</div>
                      <div className="rounded-2xl rounded-tl-md border border-border bg-muted/45 px-3.5 py-2.5">
                        <MarkdownContent
                          content={m.content || 'AI 没有生成有效回答，请重试。'}
                          compact
                          className="text-sm leading-7"
                        />
                      </div>
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
                <div className="mb-3 flex gap-3 rounded-lg border border-method-ai/20 bg-method-ai/5 p-3" aria-live="polite" role="status">
                  <div
                    aria-hidden
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-method-ai text-xs text-primary-foreground"
                  >
                    <Sparkles className="size-3.5 animate-pulse" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">AI 正在处理</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{THINKING_STEPS[thinkingStep]}</div>
                    <div className="mt-2 flex gap-1" aria-hidden>
                      {THINKING_STEPS.map((step, index) => (
                        <span key={step} className={`h-1 flex-1 rounded-full ${index <= thinkingStep ? 'bg-method-ai' : 'bg-method-ai/15'}`} />
                      ))}
                    </div>
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
              aria-label="向 AI 提问"
              rows={2}
              maxLength={CHAT_MESSAGE_LIMIT}
              disabled={!session || sending}
              className="w-full resize-none border-0 bg-transparent p-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            <div className="flex items-center justify-between gap-2 px-1 pb-1">
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {input.length}/{CHAT_MESSAGE_LIMIT}
              </span>
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
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default AskAiDrawer;
