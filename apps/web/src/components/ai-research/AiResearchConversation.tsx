'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  FileText,
  Link2,
  Loader2,
  Presentation,
  Send,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react';
import { useSearchParams } from 'next/navigation';

import { InlineAiResearchStatus } from '@/components/ai-research/InlineAiResearchStatus';
import { AiResearchBrief, type BriefValue } from '@/components/ai-research/AiResearchBrief';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  advanceResearchConversation,
  isStartResearchIntent,
  type ResearchConversationPhase,
} from '@/lib/ai-research-conversation';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { writeLastSubmitted } from '@/lib/last-submitted';
import { cn } from '@/lib/utils';

interface RadarSeed {
  id: string;
  title: string;
  url: string;
  interpretation: string | null;
  body: string | null;
}

type ReportType = 'research_report' | 'summary_brief' | 'slides';
type SourcePolicy = 'prefer_user_sources' | 'only_user_sources';

interface Message {
  id: string;
  role: 'assistant' | 'user';
  content: string;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const reportOptions: Array<{
  value: ReportType;
  label: string;
  description: string;
  icon: typeof FileText;
}> = [
  { value: 'research_report', label: '研究稿', description: '完整调研、引用和可编辑草稿', icon: FileText },
  { value: 'summary_brief', label: '快速简报', description: '一页式判断与关键依据', icon: Sparkles },
  { value: 'slides', label: '演示稿', description: '按页组织的汇报提纲', icon: Presentation },
];

export function AiResearchConversation() {
  const searchParams = useSearchParams();
  const seedId = searchParams.get('seed');
  const [phase, setPhase] = useState<ResearchConversationPhase>('understand');
  const [topic, setTopic] = useState('');
  const [context, setContext] = useState('');
  const [sourceDraft, setSourceDraft] = useState('');
  const [sourceUrls, setSourceUrls] = useState<string[]>([]);
  const [reportType, setReportType] = useState<ReportType>('research_report');
  const [sourcePolicy, setSourcePolicy] = useState<SourcePolicy>('prefer_user_sources');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    {
      id: newId('assistant'),
      role: 'assistant',
      content: '告诉我你想弄清楚的问题。我会先判断信息是否足够；只有关键范围不明确时，才会追问。',
    },
  ]);
  const [seed, setSeed] = useState<RadarSeed | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [brief, setBrief] = useState<BriefValue | null>(null);
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
        setPhase('refine');
        appendMessage('assistant', `已载入雷达内容「${value.title}」。请补充你想验证的角度、决策场景或约束；也可以直接开始调研。`);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(friendlyMessage(err, '种子雷达加载失败，可继续手动输入主题。'));
      });
    return () => { cancelled = true; };
  }, [seedId]);

  const sourceRefs = useMemo(() => {
    const refs: Array<{ type: 'url' | 'summary'; value: string; required: boolean }> = [];
    if (seed) refs.push({ type: 'summary', value: seed.id, required: true });
    sourceUrls.forEach((url) => refs.push({ type: 'url', value: url, required: sourcePolicy === 'only_user_sources' }));
    return refs;
  }, [seed, sourcePolicy, sourceUrls]);

  function appendMessage(role: Message['role'], content: string) {
    setMessages((current) => [...current, { id: newId(role), role, content }]);
  }

  function processUserMessage(value: string) {
    const trimmed = value.trim();
    if (!trimmed || submitting) return;
    setInput('');
    appendMessage('user', trimmed);

    if (isStartResearchIntent(trimmed) && topic.trim().length >= 2 && phase !== 'understand') {
      appendMessage('assistant', '好的，我会按当前问题和设置启动调研。');
      void submit();
      return;
    }

    const turn = advanceResearchConversation({ topic, context, phase }, trimmed);
    setTopic(turn.next.topic);
    setContext(turn.next.context);
    setPhase(turn.next.phase);
    appendMessage('assistant', turn.reply);
  }

  function handleMessageSubmit(event: React.FormEvent) {
    event.preventDefault();
    processUserMessage(input);
  }

  function addSourceUrl() {
    const nextUrl = sourceDraft.trim();
    if (!nextUrl) return;
    try {
      new URL(nextUrl);
    } catch {
      setError('请输入完整的网页地址，例如 https://example.com/article。');
      return;
    }
    if (sourceUrls.includes(nextUrl)) {
      setError('这条资料已经添加过了。');
      return;
    }
    if (sourceUrls.length >= 10) {
      setError('最多可指定 10 条网页资料。');
      return;
    }
    setError(null);
    setSourceUrls((current) => [...current, nextUrl]);
    setSourceDraft('');
  }

  async function submit() {
    if (topic.trim().length < 2) {
      setError('先告诉我至少 2 个字的研究主题。');
      return;
    }
    if (sourcePolicy === 'only_user_sources' && sourceRefs.length === 0) {
      setError('只使用指定资料时，至少需要一条雷达内容或网页资料。');
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
      appendMessage('assistant', '调研已启动。进度、来源和结果会持续显示在这里。');
    } catch (err) {
      setError(friendlyMessage(err, '提交失败，请稍后重试。'));
    } finally {
      setSubmitting(false);
    }
  }

  const canConfigure = phase !== 'understand';

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm" aria-label="AI 调研对话">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-gradient-to-r from-primary/8 via-card to-card px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Sparkles className="size-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold">调研对话</h2>
              <p className="text-xs text-muted-foreground">从一个问题开始，按需补齐范围与资料。</p>
            </div>
          </div>
        </div>
        <Badge variant={phase === 'ready' ? 'secondary' : 'outline'}>
          {phase === 'understand' ? '理解问题' : phase === 'refine' ? '补充范围' : '可以开始'}
        </Badge>
      </header>

      <div className="grid min-h-[560px] lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-h-0 flex-col">
          <div className="min-h-[390px] flex-1 space-y-5 overflow-y-auto px-5 py-6" aria-live="polite">
            {messages.map((message) => (
              <div key={message.id} className={cn('flex items-start gap-3', message.role === 'user' && 'flex-row-reverse')}>
                <span className={cn(
                  'grid size-8 shrink-0 place-items-center rounded-full',
                  message.role === 'assistant' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                )}>
                  {message.role === 'assistant' ? <Bot className="size-4" /> : <UserRound className="size-4" />}
                </span>
                <div className={cn('max-w-[86%]', message.role === 'user' && 'text-right')}>
                  <span className={cn('mb-1 block text-[11px] font-medium', message.role === 'assistant' ? 'text-primary' : 'text-muted-foreground')}>
                    {message.role === 'assistant' ? 'AI 调研助手' : '你'}
                  </span>
                  <p className={cn(
                    'whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-6 shadow-sm',
                    message.role === 'assistant'
                      ? 'rounded-tl-md border border-border bg-muted/45 text-foreground'
                      : 'rounded-tr-md bg-primary text-primary-foreground',
                  )}>
                    {message.content}
                  </p>
                </div>
              </div>
            ))}

            {phase !== 'understand' ? (
              <div className="ml-11">
                <AiResearchBrief
                  question={topic}
                  context={context}
                  topicHint={brief?.primaryTopicId}
                  onBriefReady={(value) => setBrief(value)}
                />
              </div>
            ) : null}

            {phase === 'refine' ? (
              <div className="ml-11 flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="xs" onClick={() => processUserMessage('跳过')} disabled={submitting}>
                  跳过背景
                </Button>
                <Button type="button" variant="secondary" size="xs" onClick={() => void submit()} disabled={submitting}>
                  {submitting ? <Loader2 className="animate-spin" /> : <Send />}
                  直接开始
                </Button>
              </div>
            ) : null}

            {activeJobId ? <InlineAiResearchStatus jobId={activeJobId} /> : null}
          </div>

          {error ? (
            <div role="alert" className="mx-5 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span className="flex-1">{error}</span>
              {canConfigure ? <Button type="button" variant="outline" size="xs" onClick={() => void submit()}>重试</Button> : null}
            </div>
          ) : null}

          <form data-ai-research-form onSubmit={handleMessageSubmit} className="border-t border-border bg-card p-4">
            <div className="rounded-xl border border-input bg-background shadow-sm transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={phase === 'understand' ? '例如：我们是否应该采用 GraphRAG？' : phase === 'refine' ? '补充决策背景，或回复“跳过”' : '继续补充调研要求，或输入“开始调研”'}
                rows={3}
                maxLength={2_000}
                aria-label="AI 调研对话输入"
                disabled={submitting}
                className="min-h-[92px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
              />
              <div className="flex items-center justify-between gap-3 px-3 pb-3">
                <span className="text-[11px] text-muted-foreground">{input.length}/2000 · Enter 换行</span>
                <Button type="submit" size="sm" disabled={!input.trim() || submitting} aria-label="发送消息">
                  <Send className="size-3.5" />
                  发送
                </Button>
              </div>
            </div>
          </form>
        </div>

        <aside className="border-t border-border bg-muted/20 p-4 lg:border-l lg:border-t-0" aria-label="调研设置">
          <div className="mb-4">
            <h3 className="text-sm font-semibold">调研设置</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">问题明确后可按需调整；不会打断对话。</p>
          </div>

          <fieldset disabled={!canConfigure || submitting} className="space-y-5 disabled:opacity-50">
            <div className="space-y-2">
              <span className="text-xs font-medium">产物</span>
              <div className="space-y-2">
                {reportOptions.map((option) => {
                  const Icon = option.icon;
                  const selected = reportType === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setReportType(option.value)}
                      className={cn(
                        'w-full rounded-lg border p-2.5 text-left transition-colors',
                        selected ? 'border-primary bg-primary/8' : 'border-border bg-card hover:bg-muted/60',
                      )}
                    >
                      <span className="flex items-center gap-2 text-xs font-medium"><Icon className="size-3.5" />{option.label}</span>
                      <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{option.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <span className="text-xs font-medium">资料范围</span>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant={sourcePolicy === 'prefer_user_sources' ? 'secondary' : 'outline'} size="xs" onClick={() => setSourcePolicy('prefer_user_sources')}>
                  优先指定资料
                </Button>
                <Button type="button" variant={sourcePolicy === 'only_user_sources' ? 'secondary' : 'outline'} size="xs" onClick={() => setSourcePolicy('only_user_sources')}>
                  只用指定资料
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="conversation-source-url" className="text-xs font-medium">补充网页资料</label>
              <div className="flex gap-2">
                <Input
                  id="conversation-source-url"
                  type="url"
                  value={sourceDraft}
                  onChange={(event) => setSourceDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addSourceUrl();
                    }
                  }}
                  placeholder="https://…"
                  className="h-8 min-w-0 text-xs"
                />
                <Button type="button" variant="outline" size="icon-sm" onClick={addSourceUrl} aria-label="添加网页资料">
                  <Link2 className="size-3.5" />
                </Button>
              </div>
              {sourceUrls.length > 0 ? (
                <ul className="space-y-1.5">
                  {sourceUrls.map((url) => (
                    <li key={url} className="flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={url}>{url}</span>
                      <button type="button" onClick={() => setSourceUrls((current) => current.filter((value) => value !== url))} className="text-muted-foreground hover:text-foreground" aria-label={`移除资料 ${url}`}>
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            {canConfigure ? (
              <Button type="button" className="w-full" onClick={() => void submit()} disabled={submitting}>
                {submitting ? <Loader2 className="animate-spin" /> : <Send />}
                {submitting ? '启动中…' : '开始调研'}
              </Button>
            ) : null}
          </fieldset>
        </aside>
      </div>
    </section>
  );
}
