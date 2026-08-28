'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, Send, Sparkles, UserRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { AiResearchChatMessage, AiResearchConversationDetail } from '@/lib/ai-research-chat';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { cn } from '@/lib/utils';

const TYPEWRITER_INTERVAL_MS = 16;
const TYPEWRITER_CHARS_PER_TICK = 4;

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
}: {
  conversation: AiResearchConversationDetail | null;
  canAsk: boolean;
  note?: string;
}) {
  const [messages, setMessages] = useState<AiResearchChatMessage[]>(conversation?.messages ?? []);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef('');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setMessages(conversation?.messages ?? []);
  }, [conversation]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, sending]);

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
    };
    const streamingId = `streaming-${Date.now()}`;
    const placeholder: AiResearchChatMessage = {
      id: streamingId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, userMessage, placeholder]);
    pendingRef.current = '';
    const slowTimer = window.setTimeout(() => setSlow(true), 12_000);

    try {
      const response = await fetch(`/api/ai-research/conversations/${encodeURIComponent(conversation.id)}/messages/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: trimmed }),
      });
      if (!response.ok || !response.body) {
        const apiError = await toApiHttpError(response, '追问失败');
        throw new Error(friendlyMessage(apiError, '追问失败，请稍后重试。'));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let complete = false;

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
          } else if (event === 'persisted') {
            // BFF 已把完整回答落库；无需额外处理。
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

  return (
    <section className="mt-5 overflow-hidden rounded-xl border border-border bg-muted/20" aria-label="研究对话">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-method-ai" />
          <h3 className="text-sm font-semibold">继续追问</h3>
        </div>
        {canAsk ? (
          <span className="text-[11px] text-muted-foreground">回答基于本次调研报告，会自动保存到对话。</span>
        ) : (
          <span className="text-[11px] text-muted-foreground">{note ?? '研究完成后可以在这里继续追问。'}</span>
        )}
      </header>

      <div ref={scrollRef} className="max-h-[420px] min-h-[180px] space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {conversation === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在恢复对话…
          </div>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有对话内容。研究完成后，可以从报告结论继续深入提问。</p>
        ) : (
          messages.map((message) => (
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
              </div>
            </div>
          ))
        )}
        {sending && slow ? (
          <p className="text-xs text-muted-foreground">模型仍在思考，可能还需要一点时间…</p>
        ) : null}
      </div>

      {err ? (
        <div role="alert" className="mx-4 mb-3 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      ) : null}

      <div className="border-t border-border p-3">
        <div className="rounded-xl border border-input bg-background shadow-sm transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
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
            <span className="text-[11px] text-muted-foreground">⌘/Ctrl + Enter 发送</span>
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
