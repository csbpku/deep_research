'use client';

// Presentational chat surface — extracted from AskAiDrawer so both the
// wide Drawer (with reading pane) and the floating BottomSheet can
// host the same chat UI. All session state lives in `useChatSession`;
// this component is pure props-in/JSX-out.
//
// M12 redesign: drops the bubble backgrounds in favour of a
// typography-led transcript (ChatGPT / Claude / Perplexity grammar),
// upgrades citations to inline numbered anchors with a collapsible
// footer (NotebookLM / Perplexity), and replaces the 3-bar progress
// with a single quiet status pill. All e2e contract markers are kept.

import React from 'react';
import {
  BookOpenCheck,
  ChevronDown,
  ExternalLink,
  Info,
  Lightbulb,
  Quote,
  Send,
  Sparkles,
  Square,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import MarkdownContent from '@/components/MarkdownContent';
import type { Anchor, ChatMessage, ContextScope } from './useChatSession';

const SUGGESTIONS = [
  '核心结论是什么？',
  '用哪些证据支撑？',
  '有哪些限制和风险？',
  '对我们有什么启发？',
] as const;

const THINKING_STEPS = [
  '正在读取原文和摘要',
  '正在整理相关证据',
  '正在生成回答',
] as const;

const SCOPE_OPTIONS: Array<{
  value: ContextScope;
  label: string;
  needsAnchor?: boolean;
  projectOnly?: boolean;
}> = [
  { value: 'full', label: '全文' },
  { value: 'selection', label: '选中', needsAnchor: true },
  { value: 'paragraph', label: '段落', needsAnchor: true },
  { value: 'section', label: '章节', needsAnchor: true },
  { value: 'project', label: '项目文档', projectOnly: true },
];

/** Quiet "AI is working" pill — replaces the 3-bar progress tracker. */
function ThinkingPill({ step, slow = false, onStop }: { step: number; slow?: boolean; onStop?: () => void }) {
  return (
    <div
      className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
      aria-live="polite"
      aria-label="AI 处理进度"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-method-ai" aria-hidden />
      <span>{slow ? '生成较慢，正在继续' : THINKING_STEPS[Math.min(step, THINKING_STEPS.length - 1)]}</span>
      {onStop ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="停止生成"
          className="-mr-1 inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Square className="size-2.5" />
        </button>
      ) : null}
    </div>
  );
}

/** Numbered citation anchor with a hover/focus tooltip (Perplexity pattern). */
function CitationAnchor({
  index,
  source,
  onSourceClick,
}: {
  index: number;
  source: NonNullable<ChatMessage['sources']>[number];
  onSourceClick?: (quote: string, sourceBlockIndex?: number, anchorId?: string) => void;
}) {
  const quote = source.quote ?? '';
  const blockIndex = source.sourceBlockIndex == null ? undefined : Number(source.sourceBlockIndex);
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        onClick={() => onSourceClick?.(quote, blockIndex, source.anchorId)}
        className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-accent/40 px-1 align-middle text-[11px] font-medium tabular-nums leading-none text-accent-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`引用 ${index + 1}：${quote.slice(0, 60)}${quote.length > 60 ? '…' : ''}`}
      >
        {index + 1}
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-72 -translate-x-1/2 translate-y-1 rounded-lg border border-border bg-popover px-3 py-2.5 text-left opacity-0 shadow-lg transition-[opacity,transform] duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
      >
        <span className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-method-ai">
          <Quote className="size-3" />
          引用依据 · 回到原文
        </span>
        <span className="line-clamp-3 text-xs leading-5 text-foreground">“{quote}”</span>
        {source.location ? (
          <span className="mt-1 block text-[10px] leading-4 text-muted-foreground">{source.location}</span>
        ) : null}
      </span>
    </span>
  );
}

export interface ChatPanelProps {
  messages: ChatMessage[];
  loading: boolean;
  sending: boolean;
  slowGeneration?: boolean;
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
  onStop?: () => void;
}

export function ChatPanel({
  messages,
  loading,
  sending,
  slowGeneration = false,
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
  onStop,
}: ChatPanelProps) {
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      onSubmit(input, selectedAnchor);
    }
  }

  const scopes = SCOPE_OPTIONS.filter((option) => {
    if (option.projectOnly && !hasProjectContext) return false;
    if (option.needsAnchor && !selectedAnchor) return false;
    return true;
  });
  const showCounter = input.length > inputLimit * 0.8;

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
        <div
          role="group"
          aria-label="AI 回答范围"
          className="flex items-center gap-1 border-b border-border px-4 py-2"
        >
          {scopes.map((option) => {
            const active = contextScope === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => onContextScopeChange(option.value)}
                className={
                  'h-6 rounded-full px-2 text-[11px] font-medium transition-colors ' +
                  (active
                    ? 'bg-method-ai text-primary-foreground'
                    : 'border border-border bg-background text-muted-foreground hover:border-method-ai/40 hover:text-foreground')
                }
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Suggestions are an empty-state aid, not permanent chat chrome. */}
      {!loading && !err && messages.length === 0 ? (
        <div className="border-b border-border px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Lightbulb className="size-3.5 text-method-ai" />
            推荐问题
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                disabled={sending}
                onClick={() => onSubmit(s, selectedAnchor)}
                className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-method-ai/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Messages */}
      <div ref={messagesRef} className="flex flex-1 flex-col overflow-y-auto bg-card px-4 py-4" aria-live="polite">
        {loading ? (
          <div className="py-4 text-center text-sm text-muted-foreground">加载会话中…</div>
        ) : err ? (
          <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-4" role="alert">
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
              <div className="mb-3 text-sm leading-relaxed text-muted-foreground">
                {contextLabel ? `我会基于${contextLabel}回答。想了解什么？` : '我已读了原文和 AI 摘要。想了解什么？'}
              </div>
            ) : null}

            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="mb-6 flex justify-end">
                  <p className="max-w-[86%] whitespace-pre-wrap break-words text-sm leading-7 text-foreground">{m.content}</p>
                </div>
              ) : (
                <div key={m.id} className="mb-6">
                    {m.content ? (
                      <div>
                        <MarkdownContent content={m.content} compact className="text-sm leading-7" />
                        {sending ? (
                          <span className="mt-1 inline-flex items-center gap-2">
                            <span
                              aria-hidden
                              className="inline-block h-3.5 w-[3px] animate-pulse rounded-full bg-method-ai align-middle"
                            />
                            {slowGeneration ? (
                              <span className="text-[11px] text-muted-foreground">生成较慢，正在继续</span>
                            ) : null}
                            {onStop ? (
                              <button
                                type="button"
                                onClick={onStop}
                                aria-label="停止生成"
                                className="inline-flex h-5 items-center gap-1 rounded-full border border-border bg-background px-2 text-[11px] text-muted-foreground transition-colors hover:border-method-ai/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <Square className="size-2.5" />
                                停止
                              </button>
                            ) : null}
                          </span>
                        ) : null}
                      </div>
                    ) : sending ? (
                      <ThinkingPill step={thinkingStep} slow={slowGeneration} onStop={onStop} />
                    ) : (
                      <p className="text-sm leading-7 text-muted-foreground">AI 暂时没有返回内容。</p>
                    )}

                    {/* Inline numbered citations + collapsible footer */}
                    {m.sources && m.sources.length > 0 ? (
                      <div className="mt-2">
                        <div className="flex flex-wrap items-center gap-1">
                          {m.sources.map((source, index) => (
                            <CitationAnchor
                              key={index}
                              index={index}
                              source={source}
                              onSourceClick={onSourceClick}
                            />
                          ))}
                        </div>
                        <details className="group/cite mt-2">
                          <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                            引用 · {m.sources.length} 段
                            <ChevronDown className="size-3 transition-transform group-open/cite:rotate-180" />
                          </summary>
                          <div className="mt-2 space-y-1.5 border-l border-border pl-3">
                            {m.sources.map((source, index) => (
                              <div key={index} className="flex items-start gap-2">
                                <span className="mt-0.5 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border border-border bg-accent/40 px-0.5 text-[10px] font-medium tabular-nums text-accent-foreground">
                                  {index + 1}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">“{source.quote ?? ''}”</p>
                                  {source.location ? (
                                    <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{source.location}</span>
                                  ) : null}
                                  {source.sourceUrl ? (
                                    <a
                                      href={source.sourceUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium text-method-ai hover:underline"
                                    >
                                      <ExternalLink className="size-3" />打开 GitHub 来源
                                    </a>
                                  ) : null}
                                </div>
                              </div>
                            ))}
                          </div>
                        </details>
                      </div>
                    ) : null}

                    {/* Honest "no verifiable citation" hint, downgraded from a banner. */}
                    {m.content && !m.sources?.length && !sending ? (
                      <p className="mt-2 flex items-center gap-1 text-[11px] leading-5 text-warning-fg">
                        <Info className="size-3 shrink-0" />
                        未检测到原文引用
                      </p>
                    ) : null}
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
            <BookOpenCheck className="mt-0.5 size-3.5 shrink-0 text-method-ai" />
            <span className="min-w-0 flex-1 line-clamp-2">引用：{selectedAnchor.quote}</span>
            <button type="button" onClick={onClearSelectedAnchor} className="shrink-0 text-method-ai hover:underline" aria-label="移除引用">移除</button>
          </div>
        ) : null}
        <div className="rounded-lg border border-input bg-background transition-colors focus-within:border-method-ai focus-within:ring-1 focus-within:ring-method-ai/30">
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
            className="w-full resize-none border-0 bg-transparent px-3 pt-2.5 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex items-center justify-end gap-2 px-2 pb-1.5">
            {showCounter ? (
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {input.length}/{inputLimit}
              </span>
            ) : null}
            <Button
              type="button"
              size="xs"
              aria-label="发送 AI 问题"
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
