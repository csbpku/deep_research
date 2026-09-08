'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Bot,
  Check,
  FileText,
  Globe2,
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

type ReportType = 'research_report' | 'summary_brief' | 'slides' | 'web_brief';
type ResearchLength = 'brief' | 'standard' | 'deep';
type SourcePolicy = 'prefer_user_sources' | 'only_user_sources';
type ResearchSourceRef = {
  type: 'url' | 'favorite' | 'research' | 'summary';
  value: string;
  required: boolean;
};

function mergeSourceRefs(
  direct: ResearchSourceRef[],
  planned: ResearchSourceRef[],
  policy: SourcePolicy,
): ResearchSourceRef[] {
  const merged = new Map<string, ResearchSourceRef>();
  for (const ref of [...direct, ...planned]) {
    const key = `${ref.type}:${ref.value}`;
    const existing = merged.get(key);
    merged.set(key, {
      ...ref,
      required: policy === 'only_user_sources' || ref.required || existing?.required === true,
    });
  }
  return Array.from(merged.values()).slice(0, 10);
}

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
  { value: 'summary_brief', label: '快速判断', description: '几秒给方向；不做完整检索或逐条依据确认', icon: Sparkles },
  { value: 'slides', label: 'Slides 提纲', description: '按页组织的可编辑提纲（不是 .pptx）', icon: Presentation },
  { value: 'web_brief', label: '网页简报', description: '独立网页阅读版，适合分享和长文阅读', icon: Globe2 },
];

const durableReportOptions = reportOptions.filter((option) => option.value !== 'summary_brief');
const quickJudgmentOption = reportOptions.find((option) => option.value === 'summary_brief');

/** 顶部阶段 stepper：理解 → 补全 → 启动 → 进行中。 */
const STEP_LABELS = ['明确问题', '确认设置', '启动研究', '进行中'] as const;

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

function ResearchRunReceipt({
  jobId,
  topic,
  reportLength,
  reportType,
  sourcePolicy,
  sourceCount,
  selectedContextCount,
}: {
  jobId: string;
  topic: string;
  reportLength: ResearchLength;
  reportType: ReportType;
  sourcePolicy: SourcePolicy;
  sourceCount: number;
  selectedContextCount: number;
}) {
  const isDeep = reportLength === 'deep';
  const outputLabel = reportOptions.find((option) => option.value === reportType)?.label ?? '研究稿';
  const sourceLabel = sourcePolicy === 'only_user_sources'
    ? '仅使用已选资料'
    : sourceCount > 0 || selectedContextCount > 0
      ? '网页搜索 + 已选资料'
      : '网页搜索';
  const selectedCount = sourceCount + selectedContextCount;

  return (
    <section className="rounded-lg border border-primary/20 bg-primary/[0.035] px-3.5 py-3" aria-label="本次研究收据">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-primary">
            <Sparkles className="size-3.5" />
            本次研究已提交
          </div>
          <h3 className="mt-1 line-clamp-2 text-sm font-medium leading-5 text-foreground">{topic}</h3>
        </div>
          <span className="shrink-0 rounded-full border border-primary/20 bg-background/70 px-2 py-0.5 text-[10px] text-primary">
          {isDeep ? '多轮研究' : '单轮研究'}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-1.5 text-[11px] sm:grid-cols-3">
        <div className="rounded-md border border-border/70 bg-background/60 px-2.5 py-2">
          <dt className="text-muted-foreground">研究深度</dt>
          <dd className="mt-0.5 font-medium text-foreground">{isDeep ? '多轮覆盖，缺口再追查' : '先完成一轮检索'}</dd>
        </div>
        <div className="rounded-md border border-border/70 bg-background/60 px-2.5 py-2">
          <dt className="text-muted-foreground">资料来源</dt>
          <dd className="mt-0.5 font-medium text-foreground">{sourceLabel}</dd>
          {selectedCount > 0 ? <div className="mt-0.5 text-[10px] text-muted-foreground">已指定 {selectedCount} 条</div> : null}
        </div>
        <div className="rounded-md border border-border/70 bg-background/60 px-2.5 py-2">
          <dt className="text-muted-foreground">交付形式</dt>
          <dd className="mt-0.5 font-medium text-foreground">{outputLabel}</dd>
        </div>
      </dl>
      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
        任务会在后台继续；下方显示真实的研究轮次、已访问页面和可核对正文。资料数量不等于结论质量，未确认内容会单独标记。
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="text-muted-foreground">启动配置已锁定，避免运行中产生歧义。</span>
        <Link href={`/ai-research/${jobId}`} className="font-medium text-primary hover:underline">
          打开任务并继续追问 →
        </Link>
      </div>
    </section>
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
  const topicQuery = searchParams.get('topic');
  const topicIdQuery = searchParams.get('topicId');
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(conversationId ?? null);
  const [phase, setPhase] = useState<ResearchConversationPhase>('understand');
  const [topic, setTopic] = useState('');
  const [context, setContext] = useState('');
  const [sourceDraft, setSourceDraft] = useState('');
  const [sourceUrls, setSourceUrls] = useState<string[]>([]);
  const [reportType, setReportType] = useState<ReportType>('research_report');
  const [reportLength, setReportLength] = useState<ResearchLength>('deep');
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
  const [planning, setPlanning] = useState(false);
  const [brief, setBrief] = useState<BriefValue | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousConversationIdRef = useRef<string | null>(conversationId ?? null);

  function resetForNewConversation() {
    setPhase('understand');
    setTopic('');
    setContext('');
    setSourceDraft('');
    setSourceUrls([]);
    setReportType('research_report');
    setReportLength('deep');
    setSourcePolicy('prefer_user_sources');
    setInput('');
    setMessages([{
      id: newId('assistant'),
      role: 'assistant',
      content: '告诉我你想弄清楚的问题。我会先判断信息是否足够；只有关键范围不明确时，才会追问。',
    }]);
    setSeed(null);
    setSubmitting(false);
    setHydrating(false);
    setConversationCreating(false);
    setPlanning(false);
    setBrief(null);
    setActiveJobId(null);
    setError(null);
  }

  // 页面 URL 变化（例如点侧栏恢复对话）时同步当前会话。
  useEffect(() => {
    const nextConversationId = conversationId ?? null;
    const previousConversationId = previousConversationIdRef.current;
    if (nextConversationId === null && previousConversationId !== null) {
      resetForNewConversation();
    }
    previousConversationIdRef.current = nextConversationId;
    setCurrentConversationId(nextConversationId);
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

  // 从专题详情页进入时直接带入主题，避免用户重复复制专题名称。
  useEffect(() => {
    const normalizedTopic = topicQuery?.trim();
    if (!normalizedTopic || seedId || currentConversationId) return;
    setTopic(normalizedTopic.slice(0, 200));
    setPhase('refine');
    pushMessage(
      'assistant',
      `已从专题「${normalizedTopic}」带入研究主题。请补充你的决策背景或验证角度，也可以直接开始调研。`,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicQuery, seedId, currentConversationId]);

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
    const effectiveSourceRefs = mergeSourceRefs(sourceRefs, brief?.brief?.contextRefs ?? [], sourcePolicy);
    if (sourcePolicy === 'only_user_sources' && effectiveSourceRefs.length === 0) {
      setError('只使用指定资料时，至少需要一条雷达内容或网页资料。');
      return;
    }
    const selectedScope = brief?.brief?.scope;
    if (selectedScope?.timeRange.preset === 'custom') {
      if (!selectedScope.timeRange.from || !selectedScope.timeRange.to) {
        setError('自定义时间范围需要同时填写开始和结束日期。');
        return;
      }
      if (selectedScope.timeRange.from > selectedScope.timeRange.to) {
        setError('自定义时间范围的结束日期不能早于开始日期。');
        return;
      }
    }
    setError(null);
    setSubmitting(true);
    const placeholder = pushMessage('assistant', '正在提交研究方案并启动调研…');
    try {
      const conversationSnapshot = [...messages, ...extraMessages].map(({ id, role, content }) => ({ id, role, content }));
      const submitBody = brief
        ? {
            brief: brief.brief
              ? {
                  ...brief.brief,
                  question: brief.brief.question || topic.trim(),
                  sourcePolicy: sourcePolicy as 'prefer_user_sources' | 'only_user_sources',
                  outputType: (reportType === 'slides' ? 'slides' : reportType === 'web_brief' ? 'web' : 'markdown') as 'markdown' | 'slides' | 'web',
                }
              : undefined,
            topic: topic.trim(),
            context: context.trim() || undefined,
            reportType,
            reportLength: reportType === 'summary_brief' ? 'brief' : reportLength,
            sourcePolicy,
            sourceRefs: effectiveSourceRefs,
            primaryTopicId: brief.primaryTopicId ?? topicIdQuery ?? undefined,
            idempotencyKey: crypto.randomUUID(),
            conversationId: currentConversationId ?? undefined,
            conversation: conversationSnapshot,
          }
        : {
            topic: topic.trim(),
            context: context.trim() || undefined,
            reportType,
            reportLength: reportType === 'summary_brief' ? 'brief' : reportLength,
            sourcePolicy,
            sourceRefs: effectiveSourceRefs,
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
  const scopeIncomplete = brief?.scopeValid === false;
  const sourceSelectionIncomplete = sourcePolicy === 'only_user_sources'
    && sourceRefs.length === 0
    && (brief?.suggestedContextIds.length ?? 0) === 0;
  const loginRequired = !!error && /登录|401|未认证/u.test(error);
  const stepIndex = activeJobId ? 3 : phase === 'understand' ? 0 : phase === 'refine' ? 1 : 2;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, submitting, hydrating]);

  return (
    <section className="overflow-hidden rounded-md border border-border bg-card" aria-label="AI 调研对话">
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
          className="min-h-[320px] flex-1 space-y-5 overflow-visible px-5 py-5 lg:max-h-[70vh] lg:overflow-y-auto"
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
                        className="touch-target rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-method-ai/50 hover:bg-method-ai/5 hover:text-foreground"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {phase !== 'understand' && !activeJobId ? (
                <div className="ml-10">
                  <AiResearchBrief
                    question={topic}
                    context={context}
                    topicHint={brief?.primaryTopicId ?? topicIdQuery ?? undefined}
                    startAction={(
                      <Button
                        type="button"
                        size="sm"
                        aria-label="开始调研"
                        onClick={() => void submit()}
                        disabled={submitting || scopeIncomplete || sourceSelectionIncomplete}
                      >
                        {submitting ? <Loader2 className="animate-spin" /> : <Send />}
                        {submitting ? '启动中…' : '开始研究'}
                      </Button>
                    )}
                      onBriefReady={(value) => setBrief(value)}
                    onPlanningChange={(value) => {
                      setPlanning(value);
                      // Never let a previous question's brief be submitted
                      // while the new plan is still loading. Direct start
                      // intentionally falls back to the current topic.
                      if (value) setBrief(null);
                    }}
                  >
                    <ResearchConfirmationControls
                      reportType={reportType}
                      reportLength={reportLength}
                      sourcePolicy={sourcePolicy}
                      sourceRefs={sourceRefs}
                      sourceUrls={sourceUrls}
                      sourceDraft={sourceDraft}
                      selectedContextCount={brief?.suggestedContextIds.length ?? 0}
                      seed={seed}
                      submitting={submitting}
                      planning={planning}
                      scopeIncomplete={scopeIncomplete}
                      onReportTypeChange={(value) => {
                        setReportType(value);
                        setReportLength(value === 'summary_brief' ? 'brief' : 'deep');
                      }}
                      onReportLengthChange={setReportLength}
                      onSourcePolicyChange={setSourcePolicy}
                      onSourceDraftChange={setSourceDraft}
                      onAddSource={addSourceUrl}
                      onRemoveSource={(url) => setSourceUrls((current) => current.filter((value) => value !== url))}
                    />
                  </AiResearchBrief>
                </div>
              ) : null}

              {phase === 'refine' && !activeJobId ? (
                <div className="ml-10 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="xs" onClick={() => processUserMessage('跳过')} disabled={submitting || !!activeJobId}>
                    跳过背景
                  </Button>
                </div>
              ) : null}

              {activeJobId ? (
                <div className="ml-10 space-y-3">
                  <ResearchRunReceipt
                    jobId={activeJobId}
                    topic={topic}
                    reportLength={reportLength}
                    reportType={reportType}
                    sourcePolicy={sourcePolicy}
                    sourceCount={sourceRefs.length}
                    selectedContextCount={brief?.suggestedContextIds.length ?? 0}
                  />
                  <InlineAiResearchStatus jobId={activeJobId} />
                </div>
              ) : null}
            </>
          )}
        </div>

        {error ? (
          <div role="alert" className="mx-5 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <span className="flex-1">{error}</span>
            {canConfigure && !activeJobId ? <Button type="button" variant="outline" size="xs" onClick={() => void submit()}>重试</Button> : null}
            {loginRequired ? (
              <Link href="/signin?callbackUrl=%2Fai-research" className="text-xs font-medium underline underline-offset-2">
                登录后继续
              </Link>
            ) : null}
          </div>
        ) : null}

        <form data-ai-research-form onSubmit={handleMessageSubmit} className="border-t border-border bg-card p-4">
    <div className="rounded-md border border-input bg-background transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={activeJobId
                ? '任务运行中，请打开完整任务查看进度或继续追问'
                : phase === 'understand'
                  ? '例如：我们是否应该采用 GraphRAG？'
                  : phase === 'refine'
                    ? '补充决策背景，或回复“跳过”'
                    : '继续补充调研要求，或输入“开始调研”'}
              rows={3}
              maxLength={2_000}
              aria-label="AI 调研对话输入"
              disabled={submitting || hydrating || !!activeJobId}
              className="min-h-[92px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between gap-3 px-3 pb-3">
              <span className="text-[11px] text-muted-foreground">
                {activeJobId ? '请在完整任务页追问' : `⌘/Ctrl + Enter 发送 · ${input.length}/2000`}
              </span>
              <Button type="submit" size="sm" disabled={!input.trim() || submitting || hydrating || !!activeJobId} aria-label="发送消息（AI 调研）">
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

function ResearchConfirmationControls({
  reportType,
  reportLength,
  sourcePolicy,
  sourceRefs,
  sourceUrls,
  sourceDraft,
  selectedContextCount,
  seed,
  submitting,
  planning,
  scopeIncomplete,
  onReportTypeChange,
  onReportLengthChange,
  onSourcePolicyChange,
  onSourceDraftChange,
  onAddSource,
  onRemoveSource,
}: {
  reportType: ReportType;
  reportLength: ResearchLength;
  sourcePolicy: SourcePolicy;
  sourceRefs: ResearchSourceRef[];
  sourceUrls: string[];
  sourceDraft: string;
  selectedContextCount: number;
  seed: RadarSeed | null;
  submitting: boolean;
  planning: boolean;
  scopeIncomplete: boolean;
  onReportTypeChange: (value: ReportType) => void;
  onReportLengthChange: (value: ResearchLength) => void;
  onSourcePolicyChange: (value: SourcePolicy) => void;
  onSourceDraftChange: (value: string) => void;
  onAddSource: () => void;
  onRemoveSource: (url: string) => void;
}) {
  const disabled = submitting;
  const sourceSelectionIncomplete = sourcePolicy === 'only_user_sources'
    && sourceRefs.length === 0
    && selectedContextCount === 0;
  return (
    <div className="space-y-4" aria-label="资料与产出">
      <fieldset disabled={disabled} className="space-y-2 disabled:opacity-50">
        <legend className="font-medium text-foreground">交付形式</legend>
        <p className="text-[11px] leading-5 text-muted-foreground">选择这次要生成的结果。</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {durableReportOptions.map((option) => {
            const Icon = option.icon;
            const selected = reportType === option.value;
            return (
              <Button
                key={option.value}
                type="button"
                variant={selected ? 'default' : 'outline'}
                size="sm"
                aria-pressed={selected}
                onClick={() => onReportTypeChange(option.value)}
                className="h-auto min-h-12 justify-start whitespace-normal px-2.5 py-2 text-left"
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="flex flex-col items-start text-left">
                  <span className="text-xs font-medium">{option.label}</span>
                  <span className="text-[11px] text-muted-foreground">{option.description}</span>
                </span>
              </Button>
              );
            })}
        </div>
        {quickJudgmentOption ? (() => {
          const Icon = quickJudgmentOption.icon;
          const selected = reportType === quickJudgmentOption.value;
          return (
            <div className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">只想先看方向？</p>
              <Button
                type="button"
                variant={selected ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={selected}
                onClick={() => onReportTypeChange(quickJudgmentOption.value)}
                className="mt-1 h-auto w-full justify-start whitespace-normal px-2 py-1.5 text-left"
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="flex flex-col items-start text-left">
                  <span className="text-xs font-medium">{quickJudgmentOption.label}</span>
                  <span className="text-[11px] text-muted-foreground">{quickJudgmentOption.description}；不会创建正式研究稿</span>
                </span>
              </Button>
            </div>
          );
        })() : null}
      </fieldset>

      {reportType !== 'summary_brief' ? (
        <fieldset disabled={disabled} className="space-y-2 disabled:opacity-50">
          <legend className="font-medium text-foreground">研究深度</legend>
          <p className="text-[11px] leading-5 text-muted-foreground">
            需要快速扫清方向，还是先覆盖多个角度，再根据证据缺口继续查？
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant={reportLength === 'deep' ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={reportLength === 'deep'}
              onClick={() => onReportLengthChange('deep')}
              className="h-auto justify-start whitespace-normal text-left"
            >
              <span className="flex flex-col items-start">
                <span className="text-xs font-medium">多轮研究 · 推荐</span>
                <span className="text-[11px] font-normal text-muted-foreground">先覆盖多个方向，再补查真实证据缺口；适合重要判断，耗时更长</span>
              </span>
            </Button>
            <Button
              type="button"
              variant={reportLength === 'standard' ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={reportLength === 'standard'}
              onClick={() => onReportLengthChange('standard')}
              className="h-auto justify-start whitespace-normal text-left"
            >
              <span className="flex flex-col items-start">
                <span className="text-xs font-medium">单轮研究</span>
                <span className="text-[11px] font-normal text-muted-foreground">只做一轮检索，适合先扫清方向，不适合证据要求很高的决策</span>
              </span>
            </Button>
          </div>
          {reportLength === 'deep' && sourcePolicy !== 'only_user_sources' ? (
            <div className="rounded-lg border border-primary/20 bg-primary/[0.04] px-3 py-2 text-[11px] leading-5 text-muted-foreground">
              <span className="font-medium text-foreground">这次会做：</span>
              拆分问题 → 并行检索 → 根据缺口补查 → 生成结果。
              证据足够时会提前收敛，不会为了凑页数继续搜索。
            </div>
          ) : null}
          {reportLength === 'deep' && sourcePolicy === 'only_user_sources' ? (
            <p className="text-[11px] leading-5 text-muted-foreground">
              当前只使用你提供的资料；不会扩展到网页做多轮检索。
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <fieldset disabled={disabled} className="space-y-2 disabled:opacity-50">
        <legend className="font-medium text-foreground">资料来源</legend>
        <p className="text-[11px] leading-5 text-muted-foreground">决定 AI 可以参考哪些资料。</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" aria-pressed={sourcePolicy === 'prefer_user_sources'} variant={sourcePolicy === 'prefer_user_sources' ? 'secondary' : 'outline'} size="sm" onClick={() => onSourcePolicyChange('prefer_user_sources')} className="h-auto justify-start whitespace-normal text-left">
            <span className="flex flex-col items-start">
              <span className="text-xs font-medium">网页搜索 + 已选资料</span>
              <span className="text-[11px] font-normal text-muted-foreground">搜索公开网页；你选中的资料也会一并纳入</span>
            </span>
          </Button>
          <Button type="button" aria-pressed={sourcePolicy === 'only_user_sources'} variant={sourcePolicy === 'only_user_sources' ? 'secondary' : 'outline'} size="sm" onClick={() => onSourcePolicyChange('only_user_sources')} className="h-auto justify-start whitespace-normal text-left">
            <span className="flex flex-col items-start">
              <span className="text-xs font-medium">仅使用已选资料</span>
              <span className="text-[11px] font-normal text-muted-foreground">不访问公开网页，只使用你添加的资料</span>
            </span>
          </Button>
        </div>
        <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">已添加资料：</span>
          {sourceRefs.length > 0 ? `${sourceRefs.length} 条${seed ? '（含当前雷达内容）' : ''}` : '尚未添加'}
          {selectedContextCount > 0 ? ` · ${selectedContextCount} 条已有资料` : ''}
        </div>
        <label htmlFor="conversation-source-url" className="block space-y-1.5">
          <span className="text-[11px] text-muted-foreground">添加网页资料（可选）</span>
          <div className="flex gap-2">
            <Input
              id="conversation-source-url"
              type="url"
              value={sourceDraft}
              onChange={(event) => onSourceDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onAddSource();
                }
              }}
              placeholder="https://…"
              className="h-8 min-w-0 text-xs"
            />
            <Button type="button" variant="outline" size="icon-sm" onClick={onAddSource} aria-label="添加网页资料">
              <Link2 className="size-3.5" />
            </Button>
          </div>
        </label>
        {sourceUrls.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {sourceUrls.map((url) => (
              <button
                key={url}
                type="button"
                onClick={() => onRemoveSource(url)}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                title={`移除资料 ${url}`}
              >
                <span className="max-w-[220px] truncate">{url}</span>
                <X className="size-3 shrink-0" />
              </button>
            ))}
          </div>
        ) : null}
      </fieldset>

      {scopeIncomplete ? (
        <p role="alert" className="rounded-md border border-warning-border/50 bg-warning-bg/40 px-3 py-2 text-[11px] leading-5 text-warning-fg">
          “优先资料时间”选择了自定义，请同时填写开始和结束日期后再启动。
        </p>
      ) : null}

      <div className="border-t border-border/70 pt-3">
        {sourceSelectionIncomplete ? (
          <p role="alert" className="rounded-md border border-warning-border/60 bg-warning-bg/35 px-2.5 py-2 text-[11px] leading-5 text-warning-fg">
            仅使用已选资料时，请先添加至少一条雷达内容、网页资料或已有资料。
          </p>
        ) : null}
        <p className="text-[11px] leading-5 text-muted-foreground">
          {
            sourceSelectionIncomplete
              ? '添加资料后，“开始研究”按钮会恢复可用。'
              : '这些选择会和上面的研究方案一起提交；点击“开始研究”后将锁定。'}
        </p>
      </div>
    </div>
  );
}
