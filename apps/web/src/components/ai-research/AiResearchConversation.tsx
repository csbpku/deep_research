'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  FileText,
  Link2,
  Loader2,
  Presentation,
  Send,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';

import { InlineAiResearchStatus } from '@/components/ai-research/InlineAiResearchStatus';
import { AiResearchBrief, type BriefValue } from '@/components/ai-research/AiResearchBrief';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  advanceResearchConversation,
  isStartResearchIntent,
  type ResearchConversationPhase,
} from '@/lib/ai-research-conversation';
import type { AiResearchConversationDetail } from '@/lib/ai-research-chat';
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

const EXAMPLE_PROMPTS = [
  '我们是否应该采用 GraphRAG？',
  '比较 Playwright 和 Cypress 的工程取舍',
  '哪些 HTML 转 Markdown 工具最不容易丢失结构？',
];

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

/** 顶部阶段 stepper：理解 → 补全 → 启动 → 进行中。 */
const STEP_LABELS = ['理解问题', '补充范围', '启动调研', '进行中'] as const;

function StepStepper({ step }: { step: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-[11px]" aria-label="调研进度">
      {STEP_LABELS.map((label, index) => {
        const state = index < step ? 'done' : index === step ? 'active' : 'todo';
        return (
          <li key={label} className="flex items-center gap-1.5">
            {index > 0 ? <span className="mx-0.5 h-px w-3 bg-border" aria-hidden /> : null}
            <span
              className={cn(
                'flex size-5 items-center justify-center rounded-full text-[10px] font-medium leading-none',
                state === 'done' && 'bg-status-succeeded-bg text-status-succeeded-fg',
                state === 'active' && 'bg-primary text-primary-foreground',
                state === 'todo' && 'bg-muted text-muted-foreground',
              )}
            >
              {state === 'done' ? <Check className="size-3" /> : index + 1}
            </span>
            <span
              className={cn(
                state === 'active' ? 'font-medium text-foreground' : 'text-muted-foreground',
                state === 'todo' && 'text-muted-foreground/60',
              )}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** 从已持久化的消息回放当前调研状态，保证刷新后还能继续同一轮规划。 */
function replayState(messages: Message[]): { topic: string; context: string; phase: ResearchConversationPhase } {
  let state: { topic: string; context: string; phase: ResearchConversationPhase } = {
    topic: '',
    context: '',
    phase: 'understand',
  };
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (isStartResearchIntent(message.content)) continue;
    const turn = advanceResearchConversation(state, message.content);
    state = turn.next;
  }
  return state;
}

export function AiResearchConversation({ conversationId }: { conversationId?: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const seedId = searchParams.get('seed');
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(conversationId ?? null);
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
  const [hydrating, setHydrating] = useState(false);
  const [conversationCreating, setConversationCreating] = useState(false);
  const [brief, setBrief] = useState<BriefValue | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 页面 URL 变化（例如点侧栏恢复对话）时同步当前会话。
  useEffect(() => {
    setCurrentConversationId(conversationId ?? null);
  }, [conversationId]);

  // 恢复持久化对话：先加载消息，再回放规划状态。
  useEffect(() => {
    if (!currentConversationId) return;
    let cancelled = false;
    setHydrating(true);
    void fetch(`/api/ai-research/conversations/${encodeURIComponent(currentConversationId)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw await toApiHttpError(response, '对话不可读');
        return await response.json() as AiResearchConversationDetail;
      })
      .then((conversation) => {
        if (cancelled) return;
        const restored = conversation.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
        }));
        setMessages(restored);
        const state = replayState(restored);
        setTopic(state.topic);
        setContext(state.context);
        setPhase(state.phase);
        if (conversation.jobId) setActiveJobId(conversation.jobId);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(friendlyMessage(err, '对话恢复失败，可以继续在下方提问。'));
      })
      .finally(() => {
        if (!cancelled) setHydrating(false);
      });
    return () => { cancelled = true; };
  }, [currentConversationId]);

  // 雷达种子预填只在还没有持久化对话时生效。
  useEffect(() => {
    if (!seedId || currentConversationId) return;
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
        pushMessage('assistant', `已载入雷达内容「${value.title}」。请补充你想验证的角度、决策场景或约束；也可以直接开始调研。`);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(friendlyMessage(err, '种子雷达加载失败，可继续手动输入主题。'));
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedId, currentConversationId]);

  const sourceRefs = useMemo(() => {
    const refs: Array<{ type: 'url' | 'summary'; value: string; required: boolean }> = [];
    if (seed) refs.push({ type: 'summary', value: seed.id, required: true });
    sourceUrls.forEach((url) => refs.push({ type: 'url', value: url, required: sourcePolicy === 'only_user_sources' }));
    return refs;
  }, [seed, sourcePolicy, sourceUrls]);

  function pushMessage(role: Message['role'], content: string): Message {
    const message: Message = { id: newId(role), role, content };
    setMessages((current) => [...current, message]);
    return message;
  }

  async function persistMessages(entries: Array<{ role: Message['role']; content: string }>) {
    if (!currentConversationId || entries.length === 0) return;
    try {
      const response = await fetch(`/api/ai-research/conversations/${encodeURIComponent(currentConversationId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: entries }),
      });
      if (!response.ok) throw new Error(`persist failed: ${response.status}`);
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[ai-research] persist messages failed', err);
    }
  }

  async function createConversation(title: string, currentMessages: Message[]) {
    setConversationCreating(true);
    try {
      const response = await fetch('/api/ai-research/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.slice(0, 200),
          messages: currentMessages.map(({ role, content }) => ({ role, content })),
        }),
      });
      if (!response.ok) throw await toApiHttpError(response, '对话创建失败');
      const conversation = await response.json() as AiResearchConversationDetail;
      setCurrentConversationId(conversation.id);
      setMessages(conversation.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
      })));
      router.replace(`/ai-research?conversation=${conversation.id}`, { scroll: false });
    } catch (err) {
      setError(friendlyMessage(err, '对话暂存失败，本次内容仍保留在当前页面。'));
    } finally {
      setConversationCreating(false);
    }
  }

  function processUserMessage(value: string) {
    const trimmed = value.trim();
    if (!trimmed || submitting || activeJobId || conversationCreating || hydrating) return;
    setInput('');
    const userMessage = pushMessage('user', trimmed);

    if (isStartResearchIntent(trimmed) && topic.trim().length >= 2 && phase !== 'understand') {
      void persistMessages([{ role: 'user', content: trimmed }]);
      void submit([userMessage]);
      return;
    }

    const turn = advanceResearchConversation({ topic, context, phase }, trimmed);
    setTopic(turn.next.topic);
    setContext(turn.next.context);
    setPhase(turn.next.phase);
    const assistantMessage = pushMessage('assistant', turn.reply);

    if (!currentConversationId && messages.length <= 2) {
      void createConversation(trimmed, [...messages, userMessage, assistantMessage]);
    } else {
      void persistMessages([
        { role: 'user', content: trimmed },
        { role: 'assistant', content: turn.reply },
      ]);
    }
  }

  function handleMessageSubmit(event: React.FormEvent) {
    event.preventDefault();
    processUserMessage(input);
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      processUserMessage(input);
    }
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

  async function submit(extraMessages: Message[] = []) {
    if (submitting || activeJobId) return;
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
    const placeholder = pushMessage('assistant', '正在生成研究计划并启动调研…');
    try {
      const conversationSnapshot = [...messages, ...extraMessages].map(({ id, role, content }) => ({ id, role, content }));
      const submitBody = brief
        ? {
            brief: brief.brief
              ? {
                  ...brief.brief,
                  question: brief.brief.question || topic.trim(),
                  sourcePolicy: sourcePolicy as 'prefer_user_sources' | 'only_user_sources',
                  outputType: (reportType === 'slides' ? 'slides' : 'markdown') as 'markdown' | 'slides',
                }
              : undefined,
            topic: topic.trim(),
            context: context.trim() || undefined,
            reportType,
            reportLength: reportType === 'summary_brief' ? 'brief' : reportType === 'slides' ? 'deep' : 'standard',
            sourcePolicy,
            sourceRefs,
            primaryTopicId: brief.primaryTopicId,
            idempotencyKey: crypto.randomUUID(),
            conversationId: currentConversationId ?? undefined,
            conversation: conversationSnapshot,
          }
        : {
            topic: topic.trim(),
            context: context.trim() || undefined,
            reportType,
            sourcePolicy,
            sourceRefs,
            idempotencyKey: crypto.randomUUID(),
            conversationId: currentConversationId ?? undefined,
            conversation: conversationSnapshot,
          };

      const response = await fetch('/api/ai-research', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submitBody),
      });
      if (!response.ok) {
        setError(friendlyMessage(await toApiHttpError(response, '提交失败'), '提交失败，请稍后重试。'));
        setMessages((current) => current.filter((message) => message.id !== placeholder.id));
        return;
      }
      const body = await response.json() as { jobId: string };
      writeLastSubmitted(body.jobId, topic.trim());
      setActiveJobId(body.jobId);
      const finalContent = '调研已启动。进度、来源和结果会持续显示在这里；完成后也可以在任务页继续追问。';
      setMessages((current) => current.map((message) => (
        message.id === placeholder.id ? { ...message, content: finalContent } : message
      )));
      void persistMessages([{ role: 'assistant', content: finalContent }]);
    } catch (err) {
      setError(friendlyMessage(err, '提交失败，请稍后重试。'));
      setMessages((current) => current.filter((message) => message.id !== placeholder.id));
    } finally {
      setSubmitting(false);
    }
  }

  const canConfigure = phase !== 'understand';
  const stepIndex = activeJobId ? 3 : phase === 'understand' ? 0 : phase === 'refine' ? 1 : 2;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, submitting, hydrating]);

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm" aria-label="AI 调研对话">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-method-ai/10 text-method-ai">
            <Sparkles className="size-4" />
          </span>
          <div>
            <h2 className="text-base font-semibold">调研对话</h2>
            <p className="text-xs text-muted-foreground">对话会自动保存，刷新后仍可继续。</p>
          </div>
        </div>
        <StepStepper step={stepIndex} />
      </header>

      <div className="flex min-h-0 flex-col">
        <div
          ref={scrollRef}
          className="min-h-[320px] max-h-[70vh] flex-1 space-y-5 overflow-y-auto px-5 py-5"
          aria-live="polite"
        >
          {hydrating ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在恢复对话…
            </div>
          ) : (
            <>
              {messages.map((message) => (
                <div key={message.id} className={cn('flex items-start gap-3', message.role === 'user' && 'flex-row-reverse')}>
                  <span className={cn(
                    'mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg',
                    message.role === 'assistant' ? 'bg-method-ai/10 text-method-ai' : 'bg-muted text-muted-foreground',
                  )}>
                    {message.role === 'assistant' ? <Bot className="size-3.5" /> : <UserRound className="size-3.5" />}
                  </span>
                  <div className={cn('min-w-0 max-w-[86%] flex-1', message.role === 'user' && 'flex-none text-right')}>
                    <span className={cn('mb-1 block text-[11px] font-semibold uppercase tracking-wide', message.role === 'assistant' ? 'text-method-ai' : 'text-muted-foreground')}>
                      {message.role === 'assistant' ? 'AI 调研助手' : '你'}
                    </span>
                    <p className="whitespace-pre-wrap text-sm leading-7 text-foreground">
                      {message.content}
                    </p>
                  </div>
                </div>
              ))}

              {phase === 'understand' && messages.length === 1 ? (
                <div className="ml-10 pt-1">
                  <div className="flex flex-wrap gap-2">
                    {EXAMPLE_PROMPTS.map((example) => (
                      <button
                        key={example}
                        type="button"
                        onClick={() => processUserMessage(example)}
                        className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-method-ai/50 hover:bg-method-ai/5 hover:text-foreground"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {phase !== 'understand' ? (
                <div className="ml-10">
                  <AiResearchBrief
                    question={topic}
                    context={context}
                    topicHint={brief?.primaryTopicId}
                    onBriefReady={(value) => setBrief(value)}
                  />
                </div>
              ) : null}

              {phase === 'refine' ? (
                <div className="ml-10 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="xs" onClick={() => processUserMessage('跳过')} disabled={submitting || !!activeJobId}>
                    跳过背景
                  </Button>
                  <Button type="button" variant="secondary" size="xs" onClick={() => void submit()} disabled={submitting || !!activeJobId}>
                    {submitting ? <Loader2 className="animate-spin" /> : <Send />}
                    直接开始
                  </Button>
                </div>
              ) : null}

              {activeJobId ? <InlineAiResearchStatus jobId={activeJobId} /> : null}
            </>
          )}
        </div>

        {error ? (
          <div role="alert" className="mx-5 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <span className="flex-1">{error}</span>
            {canConfigure && !activeJobId ? <Button type="button" variant="outline" size="xs" onClick={() => void submit()}>重试</Button> : null}
          </div>
        ) : null}

        {canConfigure && !activeJobId ? (
          <aside className="border-t border-border px-5 py-4" aria-label="调研设置">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">研究参数</h3>
                <p className="text-xs text-muted-foreground">确认产物、资料范围后即可开始。</p>
              </div>
              <Button type="button" size="sm" onClick={() => void submit()} disabled={submitting}>
                {submitting ? <Loader2 className="animate-spin" /> : <Send />}
                {submitting ? '启动中…' : '开始调研'}
              </Button>
            </div>
            <fieldset disabled={submitting} className="grid gap-4 md:grid-cols-[1.1fr_0.9fr_1.2fr] disabled:opacity-50">
              <div className="space-y-2">
                <span className="text-xs font-medium">产物</span>
                <div className="grid grid-cols-3 gap-1.5">
                  {reportOptions.map((option) => {
                    const Icon = option.icon;
                    const selected = reportType === option.value;
                    return (
                      <Button
                        key={option.value}
                        type="button"
                        variant={selected ? 'default' : 'outline'}
                        size="sm"
                        aria-pressed={selected}
                        onClick={() => setReportType(option.value)}
                        className="h-auto justify-start whitespace-normal px-2 py-2 text-left"
                      >
                        <Icon className="size-3.5" />
                        <span className="flex flex-col items-start text-left">
                          <span className="text-xs font-medium">{option.label}</span>
                          <span className="text-[11px] text-muted-foreground">{option.description}</span>
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <span className="text-xs font-medium">资料范围</span>
                <div className="grid grid-cols-2 gap-1.5">
                  <Button type="button" variant={sourcePolicy === 'prefer_user_sources' ? 'secondary' : 'outline'} size="xs" onClick={() => setSourcePolicy('prefer_user_sources')}>优先指定资料</Button>
                  <Button type="button" variant={sourcePolicy === 'only_user_sources' ? 'secondary' : 'outline'} size="xs" onClick={() => setSourcePolicy('only_user_sources')}>只用指定资料</Button>
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="conversation-source-url" className="text-xs font-medium">补充网页资料 <span className="font-normal text-muted-foreground">（可选）</span></label>
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
                  <div className="flex flex-wrap gap-1">
                    {sourceUrls.map((url) => (
                      <button
                        key={url}
                        type="button"
                        onClick={() => setSourceUrls((current) => current.filter((value) => value !== url))}
                        className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                        title={`移除资料 ${url}`}
                      >
                        <span className="max-w-[180px] truncate">{url}</span>
                        <X className="size-3 shrink-0" />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </fieldset>
          </aside>
        ) : null}

        <form data-ai-research-form onSubmit={handleMessageSubmit} className="border-t border-border bg-card p-4">
          <div className="rounded-xl border border-input bg-background shadow-sm transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={phase === 'understand' ? '例如：我们是否应该采用 GraphRAG？' : phase === 'refine' ? '补充决策背景，或回复“跳过”' : '继续补充调研要求，或输入“开始调研”'}
              rows={3}
              maxLength={2_000}
              aria-label="AI 调研对话输入"
              disabled={submitting || hydrating}
              className="min-h-[92px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between gap-3 px-3 pb-3">
              <span className="text-[11px] text-muted-foreground">⌘/Ctrl + Enter 发送 · {input.length}/2000</span>
              <Button type="submit" size="sm" disabled={!input.trim() || submitting || hydrating} aria-label="发送消息（AI 调研）">
                <Send className="size-3.5" />
                发送
              </Button>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}
