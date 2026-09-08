'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, Check, Clipboard, Loader2, Send, Sparkles, UserRound, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import MarkdownContent from '@/components/MarkdownContent';
import { Textarea } from '@/components/ui/textarea';
import { KnowledgeCardComposer } from '@/components/KnowledgeCardComposer';
import type { AiResearchChatMessage, AiResearchConversationDetail, FollowUpIntent } from '@/lib/ai-research-chat';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { cn } from '@/lib/utils';
import { formatResearchActionItems, parseResearchActionItems } from '@/lib/research-action-items';

const TYPEWRITER_INTERVAL_MS = 16;
const TYPEWRITER_CHARS_PER_TICK = 4;
const FOLLOW_UP_INTENTS: Array<{ value: FollowUpIntent; label: string; prompt: string }> = [
  { value: 'answer', label: '继续问答', prompt: '继续解释这份调研中最关键的判断，并说明依据。' },
  { value: 'verify', label: '核验证据', prompt: '核验报告中最关键的结论：逐条说明支持证据、反例或仍缺失的证据，不要把推断说成事实。' },
  { value: 'revise', label: '修改报告', prompt: '根据本次追问，提出可以纳入报告的修改内容；请明确修改依据和涉及的证据。' },
  { value: 'action', label: '生成行动项', prompt: '把报告结论整理成下一步行动项，包含负责人需要验证的假设、优先级和完成条件。' },
];

interface StreamEventPayload {
  code?: string;
  message?: string;
  message_id?: string;
  content?: string;
}

export function ResearchChatPanel({
  conversation,
  canAsk,
  note,
  reportId,
  reportContent,
  rawReportContent,
}: {
  conversation: AiResearchConversationDetail | null;
  canAsk: boolean;
  note?: string;
  reportId?: string | null;
  reportContent?: string | null;
  rawReportContent?: string | null;
}) {
  const [messages, setMessages] = useState<AiResearchChatMessage[]>(conversation?.messages ?? []);
  const [input, setInput] = useState('');
  const [intent, setIntent] = useState<FollowUpIntent>('answer');
  const [sending, setSending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [revisionMessageId, setRevisionMessageId] = useState<string | null>(null);
  const [appliedRevisionIds, setAppliedRevisionIds] = useState<Set<string>>(() => new Set());
  const [revisionSaving, setRevisionSaving] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reviewClaimPrefillRef = useRef<string | null>(null);
  const pendingRef = useRef('');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setMessages(conversation?.messages ?? []);
  }, [conversation]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, sending]);

  // A claim-level review action arrives as a deep link from the review
  // ledger.  Turn it into an explicit verification request, but keep the
  // request as a draft: navigating to “核验这条” must never send a message or
  // mutate the report without the user's confirmation.
  useEffect(() => {
    if (!canAsk || !conversation?.id || typeof window === 'undefined') return;
    const claim = new URLSearchParams(window.location.search).get('reviewClaim')?.trim();
    if (!claim || reviewClaimPrefillRef.current === claim) return;
    reviewClaimPrefillRef.current = claim;
    setIntent('verify');
    setInput([
      '请确认下面这条结论：',
      '',
      `> ${claim.replace(/\r?\n/gu, '\n> ')}`,
      '',
      '请只依据本轮保存的原文摘录，说明：支持、反驳，还是证据不足；如果无法核验，请明确指出还缺什么。',
    ].join('\n'));
    requestAnimationFrame(() => {
      const chat = document.getElementById('research-chat');
      if (!chat) return;
      window.scrollTo({
        top: Math.max(0, window.scrollY + chat.getBoundingClientRect().top - 72),
        behavior: 'smooth',
      });
    });
  }, [canAsk, conversation?.id]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  function stopTypewriter(flushAll: boolean) {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (flushAll) pendingRef.current = '';
  }

  function scheduleTypewriter(streamingId: string) {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const chunk = pendingRef.current.slice(0, TYPEWRITER_CHARS_PER_TICK);
      pendingRef.current = pendingRef.current.slice(chunk.length);
      if (chunk) {
        setMessages((current) => current.map((message) => (
          message.id === streamingId ? { ...message, content: message.content + chunk } : message
        )));
      }
      if (pendingRef.current) scheduleTypewriter(streamingId);
    }, TYPEWRITER_INTERVAL_MS);
  }

  async function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed || !conversation || sending || !canAsk) return;
    setInput('');
    setErr(null);
    setSending(true);
    setSlow(false);

    const userMessage: AiResearchChatMessage = {
      id: `optimistic-${Date.now()}`,
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
      intent,
    };
    const streamingId = `streaming-${Date.now()}`;
    const placeholder: AiResearchChatMessage = {
      id: streamingId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      intent,
    };
    setMessages((current) => [...current, userMessage, placeholder]);
    pendingRef.current = '';
    const slowTimer = window.setTimeout(() => setSlow(true), 12_000);

    try {
      const response = await fetch(`/api/ai-research/conversations/${encodeURIComponent(conversation.id)}/messages/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: trimmed, intent }),
      });
      if (!response.ok || !response.body) {
        const apiError = await toApiHttpError(response, '追问失败');
        throw new Error(friendlyMessage(apiError, '追问失败，请稍后重试。'));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let complete = false;
      let renderedAssistantId = streamingId;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const lines = frame.split('\n');
          const eventLine = lines.find((line) => line.startsWith('event: '));
          const dataLine = lines.find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          const event = eventLine ? eventLine.slice(7).trim() : 'progress';
          let rawPayload: unknown;
          try {
            rawPayload = JSON.parse(dataLine.slice(6)) as unknown;
          } catch {
            continue;
          }
          if (event === 'delta' && typeof rawPayload === 'string') {
            pendingRef.current += rawPayload;
            scheduleTypewriter(streamingId);
          } else if (event === 'delta' && rawPayload && typeof rawPayload === 'object' && typeof (rawPayload as { content?: unknown }).content === 'string') {
            pendingRef.current += (rawPayload as { content: string }).content;
            scheduleTypewriter(streamingId);
          } else if (event === 'done') {
            complete = true;
            stopTypewriter(false);
            const payload = rawPayload as StreamEventPayload;
            const content = payload.content ?? pendingRef.current;
            pendingRef.current = '';
            setMessages((current) => current.map((message) => (
              message.id === streamingId
                ? { ...message, id: payload.message_id ?? message.id, content }
                : message
            )));
            renderedAssistantId = payload.message_id ?? streamingId;
          } else if (event === 'persisted') {
            const payload = rawPayload as StreamEventPayload;
            if (payload.message_id) {
              // upstream 的 message_id 只是流内 id；切换为 BFF 真正落库的 UUID，
              // 后续“应用到报告”才能把修订可靠地关联回这条追问。
              setMessages((current) => current.map((message) => (
                message.id === renderedAssistantId || message.id === streamingId
                  ? { ...message, id: payload.message_id! }
                  : message
              )));
              renderedAssistantId = payload.message_id;
            }
          } else if (event === 'error') {
            const payload = rawPayload as StreamEventPayload;
            setErr(payload.message ?? '追问失败，请稍后重试。');
            setMessages((current) => current.map((message) => (
              message.id === streamingId
                ? { ...message, content: `回答失败：${payload.message ?? '追问失败，请稍后重试。'}` }
                : message
            )));
            complete = true;
          }
        }
      }
      if (!complete) {
        // 流在 done 前断开：保留已生成的部分，避免用户以为内容丢失。
        setMessages((current) => current.map((message) => (
          message.id === streamingId ? { ...message, content: message.content || '回答已中断，请重试。' } : message
        )));
      }
    } catch (sendError) {
      setErr(sendError instanceof Error ? sendError.message : '追问失败，请稍后重试。');
      setMessages((current) => current.map((message) => (
        message.id === streamingId
          ? { ...message, content: `回答失败：${sendError instanceof Error ? sendError.message : '追问失败，请稍后重试。'}` }
          : message
      )));
    } finally {
      window.clearTimeout(slowTimer);
      setSlow(false);
      setSending(false);
      pendingRef.current = '';
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
  }

  async function applyRevision(message: AiResearchChatMessage) {
    if (message.intent !== 'revise' || !reportId || !reportContent || !rawReportContent || revisionSaving) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(message.id)) {
      setRevisionError('这条回答还没有完成保存，请稍候再试。');
      return;
    }
    const addition = message.content.trim();
    if (!addition) return;
    setRevisionSaving(true);
    setRevisionError(null);
    try {
      const messageIndex = messages.findIndex((item) => item.id === message.id);
      const question = messageIndex >= 0
        ? [...messages.slice(0, messageIndex)].reverse().find((item) => item.role === 'user')?.content
        : undefined;
      const separator = rawReportContent.trimEnd().endsWith('\n') ? '\n' : '\n\n';
      const quotedQuestion = (question ?? '本次追问').split(/\r?\n/u).map((line) => `> ${line}`).join('\n');
      const provenance = [
        '## 追问补充',
        '',
        `**追问：**\n${quotedQuestion}`,
        '',
        addition,
        '',
      ].join('\n');
      const nextBody = `${rawReportContent.trimEnd()}${separator}${provenance}`;
      const response = await fetch(`/api/researches/${encodeURIComponent(reportId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          body: nextBody,
          revisionContext: {
            sourceMessageId: message.id,
            reason: question ? `根据追问「${question.slice(0, 180)}${question.length > 180 ? '…' : ''}」补充报告` : '根据本次追问补充报告',
          },
        }),
      });
      if (!response.ok) {
        const apiError = await toApiHttpError(response, '应用修订失败');
        throw new Error(friendlyMessage(apiError, '应用修订失败，请稍后重试。'));
      }
      setRevisionMessageId(null);
      setRevisionError(null);
      setAppliedRevisionIds((current) => new Set(current).add(message.id));
      window.dispatchEvent(new CustomEvent('ai-research-report-updated', { detail: { reportId } }));
    } catch (error) {
      setRevisionError(error instanceof Error ? error.message : '应用修订失败，请稍后重试。');
    } finally {
      setRevisionSaving(false);
    }
  }

  return (
    <section id="research-chat" className="mt-5 overflow-hidden rounded-md border border-border bg-muted/20" aria-label="研究对话">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-method-ai" />
          <h3 className="text-sm font-semibold">继续追问</h3>
        </div>
        {canAsk ? (
          <span className="text-[11px] text-muted-foreground">{note ?? '回答基于本次调研报告，会自动保存到对话。'}</span>
        ) : (
          <span className="text-[11px] text-muted-foreground">{note ?? '研究完成后可以在这里继续追问。'}</span>
        )}
      </header>

      <div
        ref={scrollRef}
        className="min-h-[180px] space-y-4 overflow-visible px-4 py-4 lg:max-h-[420px] lg:overflow-y-auto"
        aria-live="polite"
      >
        {conversation === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在恢复对话…
          </div>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有对话内容。研究完成后，可以从报告结论继续深入提问。</p>
        ) : (
          messages.map((message, index) => (
            <div key={message.id} className={cn('flex items-start gap-2.5', message.role === 'user' && 'flex-row-reverse')}>
              <span className={cn(
                'grid size-6 shrink-0 place-items-center rounded-full',
                message.role === 'assistant' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
              )}>
                {message.role === 'assistant' ? <Bot className="size-3.5" /> : <UserRound className="size-3.5" />}
              </span>
              <div className="min-w-0 max-w-[86%]">
                <p className="text-[11px] font-medium text-muted-foreground">
                  {message.role === 'assistant' ? 'AI 调研助手' : '你'}
                  {message.id.startsWith('streaming-') ? ' · 生成中' : ''}
                </p>
                {message.role === 'assistant' && message.content ? (
                  message.intent === 'action'
                    ? <ActionItemsView content={message.content} />
                    : <MarkdownContent content={message.content} compact className="mt-0.5 text-sm leading-6" />
                ) : (
                  <p className="mt-0.5 whitespace-pre-wrap text-sm leading-6">
                    {message.content}
                    {message.id.startsWith('streaming-') && message.content === '' && sending ? (
                      <span className="ml-1 inline-flex gap-0.5">
                        <span className="size-1 animate-bounce rounded-full bg-muted-foreground" />
                        <span className="size-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:120ms]" />
                        <span className="size-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:240ms]" />
                      </span>
                    ) : null}
                  </p>
                )}
                {reportId && reportContent && message.intent === 'revise' && message.role === 'assistant' && message.content && index === messages.length - 1 ? (
                  <div className="mt-2">
                    {appliedRevisionIds.has(message.id) ? (
                      <p className="text-[11px] text-status-success-fg">已生成新版本 · 可在编辑器的版本历史中恢复</p>
                    ) : revisionMessageId === message.id ? (
                      <div className="rounded-lg border border-primary/30 bg-primary/[0.04] p-3 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-medium text-foreground">应用为报告新版本？</p>
                          <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted" onClick={() => setRevisionMessageId(null)} aria-label="关闭修订预览">
                            <X className="size-3.5" />
                          </button>
                        </div>
                        <p className="mt-1 text-muted-foreground">这会把本次追问整理为报告末尾的“追问补充”，原版本仍可在版本历史中恢复。</p>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <div className="rounded border border-border bg-background p-2">
                            <p className="mb-1 font-medium text-muted-foreground">原报告末尾</p>
                            <p className="line-clamp-5 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{reportContent.trim().slice(-420)}</p>
                          </div>
                          <div className="rounded border border-primary/20 bg-primary/[0.04] p-2">
                            <p className="mb-1 font-medium text-primary">将新增</p>
                            <p className="line-clamp-5 whitespace-pre-wrap text-[11px] leading-5 text-foreground">## 追问补充{`\n\n`}{message.content}</p>
                          </div>
                        </div>
                        {revisionError ? <p role="alert" className="mt-2 text-destructive">{revisionError}</p> : null}
                        <div className="mt-3 flex justify-end gap-2">
                          <Button type="button" variant="ghost" size="xs" onClick={() => setRevisionMessageId(null)} disabled={revisionSaving}>取消</Button>
                          <Button type="button" size="xs" onClick={() => void applyRevision(message)} disabled={revisionSaving}>
                            <Check className="size-3.5" />{revisionSaving ? '保存中…' : '确认生成新版本'}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="text-[11px] font-medium text-primary hover:underline" onClick={() => { setRevisionError(null); setRevisionMessageId(message.id); }}>
                        应用到报告 · 先预览变更
                      </button>
                    )}
                  </div>
                ) : null}
                {message.role === 'assistant' && message.content && !message.id.startsWith('streaming-') ? (
                  <KnowledgeCardComposer sourceKind="research_chat" messageId={message.id} />
                ) : null}
              </div>
            </div>
          ))
        )}
        {sending && slow ? (
          <p className="text-xs text-muted-foreground">模型仍在思考，可能还需要一点时间…</p>
        ) : null}
      </div>

      {canAsk && !sending && messages.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-4 py-2.5">
          <span className="mr-1 self-center text-[11px] text-muted-foreground">研究动作：</span>
          {FOLLOW_UP_INTENTS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={intent === item.value}
              onClick={() => { setIntent(item.value); setInput(item.prompt); }}
              className={cn(
                'touch-target rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                intent === item.value ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      {err ? (
        <div role="alert" className="mx-4 mb-3 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      ) : null}

      <div className="border-t border-border p-3">
        <div className="rounded-md border border-input bg-background transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder={canAsk ? '针对这份调研继续追问…' : '研究完成后可继续追问'}
            rows={2}
            maxLength={32000}
            aria-label="研究对话输入"
            disabled={!canAsk || sending}
            className="min-h-[64px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
            <span className="text-[11px] text-muted-foreground">{FOLLOW_UP_INTENTS.find((item) => item.value === intent)?.label} · ⌘/Ctrl + Enter 发送</span>
            <Button type="button" size="sm" onClick={() => void sendMessage()} disabled={!input.trim() || !canAsk || sending} aria-label="发送追问">
              {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
              发送
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ActionItemsView({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const items = parseResearchActionItems(content);

  async function copyItems() {
    if (items.length === 0) return;
    try {
      await navigator.clipboard.writeText(formatResearchActionItems(items));
      setCopied(true);
      setCopyError(false);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyError(true);
    }
  }

  if (items.length === 0) {
    return (
      <div className="mt-1 rounded-lg border border-warning-border/60 bg-warning-bg/20 p-3">
        <p className="text-xs font-medium text-foreground">行动项未按约定格式返回</p>
        <p className="mt-1 text-[11px] leading-5 text-muted-foreground">原始回答仍已保存；请重试生成行动项，避免把缺失的负责人或完成条件猜出来。</p>
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-medium text-primary">查看原始回答</summary>
          <MarkdownContent content={content} compact className="mt-2 text-sm leading-6" />
        </details>
      </div>
    );
  }

  return (
    <section className="mt-1 rounded-lg border border-primary/20 bg-primary/[0.035] p-3" aria-label="结构化行动项">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-foreground">行动项</p>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">独立于研究稿保存，不会自动写入报告。</p>
        </div>
        <Button type="button" variant="outline" size="xs" onClick={() => void copyItems()} aria-label="复制行动项">
          {copied ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      <div className="mt-3 space-y-2">
        {items.map((item, index) => (
          <article key={`${item.title}-${index}`} className="rounded-md border border-border bg-background p-2.5">
            <div className="flex items-start gap-2">
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
              <h4 className="min-w-0 flex-1 text-xs font-semibold leading-5 text-foreground">{item.title}</h4>
              <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.priority ?? '待判断'}</span>
            </div>
            <dl className="mt-2 grid gap-1.5 text-[11px] leading-5 sm:grid-cols-2">
              <ActionField label="负责人" value={item.owner} />
              <ActionField label="待验证假设" value={item.hypothesis} />
              <ActionField label="完成条件" value={item.completionCriteria} />
              <ActionField label="依据" value={item.basis} />
            </dl>
          </article>
        ))}
      </div>
      {copyError ? <p role="alert" className="mt-2 text-[11px] text-destructive">复制失败，请手动选择行动项文本。</p> : null}
    </section>
  );
}

function ActionField({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0 rounded border border-border/70 bg-muted/20 px-2 py-1.5">
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-foreground">{value ?? '未明确'}</dd>
    </div>
  );
}
