'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bot, FileText, Loader2, Send, Sparkles, UserRound } from 'lucide-react';
import { useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { writeLastSubmitted } from '@/lib/last-submitted';
import { InlineAiResearchStatus } from '@/components/ai-research/InlineAiResearchStatus';

interface RadarSeed {
  id: string;
  title: string;
  url: string;
  interpretation: string | null;
  body: string | null;
}

type ReportType = 'research_report' | 'summary_brief' | 'slides';
type SourcePolicy = 'prefer_user_sources' | 'only_user_sources';
type ConversationStep = 'goal' | 'context' | 'confirm';

interface Message {
  id: string;
  role: 'assistant' | 'user';
  content: string;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function AiResearchConversation() {
  const searchParams = useSearchParams();
  const seedId = searchParams.get('seed');
  const [step, setStep] = useState<ConversationStep>('goal');
  const [topic, setTopic] = useState('');
  const [context, setContext] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [reportType, setReportType] = useState<ReportType>('research_report');
  const [sourcePolicy, setSourcePolicy] = useState<SourcePolicy>('prefer_user_sources');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    {
      id: newId('assistant'),
      role: 'assistant',
      content: '你想研究什么？先告诉我一个主题、问题或决策场景，我会帮你把调研目标收窄。',
    },
  ]);
  const [seed, setSeed] = useState<RadarSeed | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!seedId) return;
    let cancelled = false;
    void fetch(`/api/radar/${encodeURIComponent(seedId)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw await toApiHttpError(response, '种子雷达不可读');
        return await response.json() as RadarSeed;
      })
      .then((value) => {
        if (cancelled) return;
        setSeed(value);
        setTopic(value.title.slice(0, 200));
        setMessages((current) => [
          ...current,
          {
            id: newId('assistant'),
            role: 'assistant',
            content: `我已经载入雷达内容「${value.title}」。你可以直接补充想验证的角度，或者确认后开始调研。`,
          },
        ]);
        setStep('context');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(friendlyMessage(err, '种子雷达加载失败，可继续手动输入主题。'));
      });
    return () => { cancelled = true; };
  }, [seedId]);

  const sourceRefs = useMemo(() => {
    const refs: Array<{ type: 'url' | 'summary'; value: string; required: boolean }> = [];
    if (seed) refs.push({ type: 'summary', value: seed.id, required: true });
    if (sourceUrl.trim()) refs.push({ type: 'url', value: sourceUrl.trim(), required: false });
    return refs;
  }, [seed, sourceUrl]);

  function appendMessage(role: Message['role'], content: string) {
    setMessages((current) => [...current, { id: newId(role), role, content }]);
  }

  function handleMessageSubmit(event: React.FormEvent) {
    event.preventDefault();
    const value = input.trim();
    if (!value || submitting) return;
    setInput('');
    appendMessage('user', value);

    if (step === 'goal') {
      setTopic(value.slice(0, 200));
      setStep('context');
      appendMessage('assistant', '收到。你的团队背景、现有方案或希望做出的决策是什么？没有的话直接回复“无”。');
      return;
    }
    if (step === 'context') {
      if (value !== '无') setContext(value.slice(0, 2000));
      setStep('confirm');
      appendMessage('assistant', '目标和背景已经足够。请确认产物类型；如果需要限定资料，也可以在下方补充 URL。');
      return;
    }
    appendMessage('assistant', '我会按当前配置启动调研，并在结果页持续展示进度和来源。');
    void submit();
  }

  async function submit() {
    if (topic.trim().length < 2) {
      setError('先告诉我至少 2 个字的研究主题。');
      return;
    }
    if (sourcePolicy === 'only_user_sources' && sourceRefs.length === 0) {
      setError('只使用指定资料时，至少需要一条雷达、调研或网页资料。');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch('/api/ai-research', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: topic.trim(),
          context: context.trim() || undefined,
          reportType,
          sourcePolicy,
          sourceRefs,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      if (!response.ok) {
        setError(friendlyMessage(await toApiHttpError(response, '提交失败'), '提交失败，请稍后重试。'));
        return;
      }
      const body = await response.json() as { jobId: string };
      writeLastSubmitted(body.jobId, topic.trim());
      setActiveJobId(body.jobId);
      appendMessage('assistant', '调研已启动。我会在这里展示进度和结果，不需要离开当前页面。');
    } catch (err) {
      setError(friendlyMessage(err, '提交失败，请稍后重试。'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-4xl rounded-xl border border-border bg-card shadow-sm">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <h2 className="text-base font-semibold">和 AI 一起定义调研</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">先说问题，再确认资料和产物；不需要一开始就填完整表单。</p>
      </div>

      <div className="max-h-[520px] space-y-4 overflow-y-auto px-5 py-5" aria-live="polite">
        {messages.map((message) => (
          <div key={message.id} className={cn('flex gap-3', message.role === 'user' && 'flex-row-reverse')}>
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted">
              {message.role === 'assistant' ? <Bot className="size-4 text-primary" /> : <UserRound className="size-4 text-muted-foreground" />}
            </span>
            <p className={cn(
              'max-w-[80%] whitespace-pre-wrap rounded-md px-3 py-2 text-sm leading-6',
              message.role === 'assistant' ? 'bg-muted/70 text-foreground' : 'bg-primary text-primary-foreground',
            )}>
              {message.content}
            </p>
          </div>
        ))}

        {activeJobId ? <InlineAiResearchStatus jobId={activeJobId} /> : null}

        {step === 'confirm' ? (
          <div className="ml-10 space-y-3 rounded-md border border-border bg-background p-4">
            <div className="grid gap-1.5">
              <label htmlFor="conversation-source-url" className="text-xs font-medium">补充网页资料（可选）</label>
              <Input
                id="conversation-source-url"
                type="url"
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
                placeholder="https://example.com/article"
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <button type="button" onClick={() => setReportType('research_report')} className={cn('rounded-md border p-3 text-left text-xs', reportType === 'research_report' ? 'border-primary bg-accent' : 'border-border')}>
                <span className="flex items-center gap-2 font-medium"><FileText className="size-3.5" />研究稿</span>
                <span className="mt-1 block text-muted-foreground">完整调研、引用和可编辑草稿</span>
              </button>
              <button type="button" onClick={() => setReportType('summary_brief')} className={cn('rounded-md border p-3 text-left text-xs', reportType === 'summary_brief' ? 'border-primary bg-accent' : 'border-border')}>
                <span className="flex items-center gap-2 font-medium"><Sparkles className="size-3.5" />快速简报</span>
                <span className="mt-1 block text-muted-foreground">更快得到一页式结论</span>
              </button>
              <button type="button" onClick={() => setReportType('slides')} className={cn('rounded-md border p-3 text-left text-xs', reportType === 'slides' ? 'border-primary bg-accent' : 'border-border')}>
                <span className="flex items-center gap-2 font-medium"><FileText className="size-3.5" />Slides 演示稿</span>
                <span className="mt-1 block text-muted-foreground">按页面组织的 Markdown 演示稿</span>
              </button>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Button type="button" variant={sourcePolicy === 'prefer_user_sources' ? 'secondary' : 'outline'} size="xs" onClick={() => setSourcePolicy('prefer_user_sources')}>
                优先指定资料
              </Button>
              <Button type="button" variant={sourcePolicy === 'only_user_sources' ? 'secondary' : 'outline'} size="xs" onClick={() => setSourcePolicy('only_user_sources')}>
                只用指定资料
              </Button>
              <Button type="button" size="xs" onClick={() => void submit()} disabled={submitting}>
                {submitting ? <Loader2 className="animate-spin" /> : <Send />}
                {submitting ? '启动中…' : '开始调研'}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="mx-5 mb-3 flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="flex-1">{error}</span>
          {step === 'confirm' ? (
            <Button type="button" variant="outline" size="xs" onClick={() => void submit()}>
              重试
            </Button>
          ) : null}
        </div>
      ) : null}

      <form data-ai-research-form onSubmit={handleMessageSubmit} className="flex items-end gap-2 border-t border-border p-4">
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={step === 'goal' ? '例如：我们是否应该采用 GraphRAG？' : step === 'context' ? '补充背景，或回复“无”' : '继续补充要求，或点击上方开始调研'}
          rows={2}
          maxLength={2000}
          aria-label="AI 调研对话输入"
          disabled={submitting}
        />
        <Button type="submit" size="sm" disabled={!input.trim() || submitting} aria-label="发送消息">
          <Send />
        </Button>
      </form>
    </div>
  );
}
