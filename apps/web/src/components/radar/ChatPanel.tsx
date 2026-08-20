'use client';

// Presentational chat surface — extracted from AskAiDrawer so both the
// wide Drawer (with reading pane) and the floating BottomSheet can
// host the same chat UI. All session state lives in `useChatSession`;
// this component is pure props-in/JSX-out.

import {
  ExternalLink,
  Lightbulb,
  Send,
  Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import MarkdownContent from '@/components/MarkdownContent';
import type { Anchor, ChatMessage, ContextScope } from './useChatSession';

const SUGGESTIONS = [
  '这篇文章的核心结论是什么？',
  '作者用哪些证据支持这个结论？',
  '文中提到的限制和风险有哪些？',
  '对我们团队可能有什么启发？请标注不确定性。',
] as const;

const THINKING_STEPS = [
  '正在读取原文和摘要',
  '正在整理相关证据',
  '正在生成回答',
] as const;

function ThinkingTrace({ step }: { step: number }) {
  return (
    <div className="rounded-xl border border-method-ai/20 bg-method-ai/5 px-3 py-2.5" aria-live="polite" aria-label="AI 处理进度">
      <div className="flex items-center gap-2 text-xs font-medium text-method-ai">
        <span className="flex size-5 items-center justify-center rounded-full bg-method-ai text-primary-foreground">
          <Sparkles className="size-3 animate-pulse" />
        </span>
        <span>{THINKING_STEPS[Math.min(step, THINKING_STEPS.length - 1)]}</span>
      </div>
      <div className="mt-2 flex gap-1" aria-hidden>
        {THINKING_STEPS.map((label, index) => (
          <span key={label} className={`h-1 flex-1 rounded-full ${index <= step ? 'bg-method-ai' : 'bg-method-ai/15'}`} />
        ))}
      </div>
    </div>
  );
}

export interface ChatPanelProps {
  messages: ChatMessage[];
  loading: boolean;
  sending: boolean;
  thinkingStep: number;
  err: string | null;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (content: string, anchor?: Anchor | null) => void;
  onRetryLoad: () => void;
  messagesRef: React.RefObject<HTMLDivElement | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** When true, hide the in-panel context strip (used inside BottomSheet). */
  compact?: boolean;
  /** Optional context excerpt shown in compact mode (e.g. on mobile drawers). */
  contextExcerpt?: string | null;
  /** Explicit grounding status for the current reading mode. */
  contextLabel?: string | null;
  inputLimit?: number;
  selectedAnchor?: Anchor | null;
  onClearSelectedAnchor?: () => void;
  onSourceClick?: (quote: string, sourceBlockIndex?: number, anchorId?: string) => void;
  contextScope?: ContextScope;
  onContextScopeChange?: (scope: ContextScope) => void;
  hasProjectContext?: boolean;
}

export function ChatPanel({
  messages,
  loading,
  sending,
  thinkingStep,
  err,
  input,
  onInputChange,
  onSubmit,
  onRetryLoad,
  messagesRef,
  textareaRef,
  compact = false,
  contextExcerpt = null,
  contextLabel = null,
  inputLimit = 32000,
  selectedAnchor = null,
  onClearSelectedAnchor,
  onSourceClick,
  contextScope = 'full',
  onContextScopeChange,
  hasProjectContext = false,
}: ChatPanelProps) {
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
            onSubmit(input, selectedAnchor);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      {contextLabel ? (
        <div className="flex items-center gap-2 border-b border-border bg-method-ai/5 px-4 py-2 text-[11px] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-method-ai" aria-hidden />
          <span className="font-medium text-foreground">讨论上下文</span>
          <span className="truncate">{contextLabel}</span>
        </div>
      ) : null}
      {/* Optional context strip (compact / mobile only) */}
      {!compact && contextExcerpt ? (
        <div className="border-b border-border bg-accent/30 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground lg:hidden">
          <div className="flex items-center gap-1.5">
            <Sparkles className="size-3 shrink-0 text-method-ai" />
            <span className="font-medium text-foreground">正文摘录</span>
          </div>
          <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap">{contextExcerpt}</p>
        </div>
      ) : null}

      {onContextScopeChange ? (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">回答范围</span>
          <select
            aria-label="AI 回答范围"
            value={contextScope}
            onChange={(event) => onContextScopeChange(event.target.value as ContextScope)}
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          >
            <option value="selection" disabled={!selectedAnchor}>选中文本</option>
            <option value="paragraph" disabled={!selectedAnchor}>当前段落</option>
            <option value="section" disabled={!selectedAnchor}>当前章节</option>
            <option value="full">全文</option>
            {hasProjectContext ? <option value="project">项目文档</option> : null}
          </select>
        </div>
      ) : null}

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
              disabled={sending}
              onClick={() => onSubmit(s, selectedAnchor)}
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
              onClick={onRetryLoad}
            >
              重试连接
            </Button>
          </div>
        ) : (
          <>
            {messages.length === 0 ? (
              <div className="mb-3 flex gap-3">
                <div
                  aria-hidden
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-method-ai text-xs text-primary-foreground"
                >
                  <Sparkles className="size-3.5" />
                </div>
                <div className="text-sm leading-relaxed text-muted-foreground">
                  {contextLabel ? `我会基于${contextLabel}回答。想了解什么？` : '我已读了原文和 AI 摘要。想了解什么？'}
                  <div className="mt-1 text-[11px]">可以选中具体段落让 AI 解释，也可以直接发问。</div>
                </div>
              </div>
            ) : null}

            {messages.map((m) =>
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
                      {m.content || !sending ? (
                        <MarkdownContent content={m.content || 'AI 暂时没有返回内容。'} compact className="text-sm leading-7" />
                      ) : (
                        <ThinkingTrace step={thinkingStep} />
                      )}
                    </div>
                    {m.sources && m.sources.length > 0 ? (
                      <div className="mt-2 space-y-1.5">
                        {m.sources.map((s, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => onSourceClick?.(s.quote ?? '', s.sourceBlockIndex == null ? undefined : Number(s.sourceBlockIndex), s.anchorId)}
                            className="block w-full border-l-2 border-method-ai bg-accent/40 px-3 py-1.5 text-left text-xs leading-5 text-muted-foreground hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-method-ai/40"
                          >
                            <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.08em] text-method-ai">引用依据 · 回到原文</span>
                            <span>“{s.quote}”</span>
                            {s.location ? <span className="mt-0.5 block text-[10px] text-muted-foreground">{s.location}</span> : null}
                            {s.sourceUrl ? (
                              <a
                                href={s.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(event) => event.stopPropagation()}
                                className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-method-ai hover:underline"
                              >
                                <ExternalLink className="size-3" />打开 GitHub 来源
                              </a>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {m.content && !m.sources?.length && !sending ? (
                      <div className="mt-2 border-l-2 border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] leading-5 text-amber-800">
                        未检测到可验证的原文引用，请结合正文谨慎使用。
                      </div>
                    ) : null}
                    {m.latencyMs ? (
                      <div className="mt-1.5 text-[11px] text-muted-foreground">
                        {m.latencyMs < 1000
                          ? `${m.latencyMs}ms`
                          : `${(m.latencyMs / 1000).toFixed(1)}s`}
                      </div>
                    ) : null}
                  </div>
                </div>
              ),
            )}

          </>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border bg-card p-3">
        {selectedAnchor?.quote ? (
          <div className="mb-2 flex items-start gap-2 rounded-md border border-method-ai/20 bg-method-ai/5 px-2.5 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 line-clamp-2">引用：{selectedAnchor.quote}</span>
            <button type="button" onClick={onClearSelectedAnchor} className="shrink-0 text-method-ai hover:underline" aria-label="移除引用">移除</button>
          </div>
        ) : null}
        <div className="rounded-md border border-input focus-within:border-method-ai focus-within:ring-1 focus-within:ring-method-ai/40">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="提问… (⌘+Enter 发送)"
            aria-label="向 AI 提问"
            rows={2}
            maxLength={inputLimit}
            disabled={loading || err !== null || sending}
            className="w-full resize-none border-0 bg-transparent p-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex items-center justify-between gap-2 px-1 pb-1">
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {input.length}/{inputLimit}
            </span>
            <Button
              type="button"
              size="xs"
              disabled={!input.trim() || loading || err !== null || sending}
              onClick={() => onSubmit(input, selectedAnchor)}
            >
              <Send className="size-3.5" />
              发送
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
