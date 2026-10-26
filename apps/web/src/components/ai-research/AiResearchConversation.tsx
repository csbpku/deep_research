'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import NextLink from 'next/link';
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
import { AiResearchButton as Button, AiResearchTextarea as Textarea } from '@/components/ai-research/AiResearchMaterial';
import { AppTextField as Input } from '@/components/material/AppTextField';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import {
  advanceResearchConversation,
  isStartResearchIntent,
  type ResearchConversationPhase,
} from '@/lib/ai-research-conversation';
import type { AiResearchConversationDetail } from '@/lib/ai-research-chat';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { writeLastSubmitted } from '@/lib/last-submitted';
import { createUuid } from '@/lib/uuid';

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
    <Box component="ol" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, m: 0, p: 0, listStyle: 'none', typography: 'metadata' }} aria-label="调研进度">
      {STEP_LABELS.map((label, index) => {
        const state = index < step ? 'done' : index === step ? 'active' : 'todo';
        return (
          <Box component="li" key={label} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {index > 0 ? <Box component="span" sx={{ mx: 0.5, width: 12, height: '1px', bgcolor: 'divider' }} aria-hidden /> : null}
            <Box component="span" sx={{ display: 'flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center', borderRadius: '50%', typography: 'metadata', fontWeight: 500, lineHeight: 1, ...(state === 'done' ? { bgcolor: 'var(--dr-color-success-container)', color: 'success.main' } : state === 'active' ? { bgcolor: 'primary.main', color: 'primary.contrastText' } : { bgcolor: 'action.hover', color: 'text.disabled' }) }}>
              {state === 'done' ? <Check size={12} /> : index + 1}
            </Box>
            <Typography component="span" variant="metadata" sx={{ fontWeight: state === 'active' ? 500 : undefined, color: state === 'active' ? 'text.primary' : 'text.secondary' }}>
              {label}
            </Typography>
          </Box>
        );
      })}
    </Box>
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
    <Paper component="section" variant="outlined" sx={{ borderColor: 'primary.main', bgcolor: 'action.selected', px: 2, py: 1.5 }} aria-label="本次研究收据">
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1.5 }}>
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, typography: 'metadata', fontWeight: 600, color: 'primary.main' }}>
            <Sparkles size={14} />
            本次研究已提交
          </Box>
          <Typography component="h3" variant="body2" sx={{ mt: 0.5, display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, lineHeight: 1.6, fontWeight: 500 }}>{topic}</Typography>
        </Box>
          <Box component="span" sx={{ flexShrink: 0, border: 1, borderColor: 'primary.main', borderRadius: 999, bgcolor: 'background.default', px: 1, py: 0.5, typography: 'metadata', color: 'primary.main' }}>
          {isDeep ? '多轮研究' : '单轮研究'}
        </Box>
      </Box>
      <Box component="dl" sx={{ mt: 1.5, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 1, typography: 'metadata' }}>
        <Box component="div" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default', px: 1.5, py: 1 }}>
          <Typography component="dt" variant="metadata" color="text.secondary">研究深度</Typography>
          <Typography component="dd" variant="metadata" sx={{ mt: 0.5, ml: 0, fontWeight: 500 }}>{isDeep ? '多轮覆盖，缺口再追查' : '先完成一轮检索'}</Typography>
        </Box>
        <Box component="div" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default', px: 1.5, py: 1 }}>
          <Typography component="dt" variant="metadata" color="text.secondary">资料来源</Typography>
          <Typography component="dd" variant="metadata" sx={{ mt: 0.5, ml: 0, fontWeight: 500 }}>{sourceLabel}</Typography>
          {selectedCount > 0 ? <Typography component="div" variant="metadata" color="text.secondary" sx={{ mt: 0.5 }}>已指定 {selectedCount} 条</Typography> : null}
        </Box>
        <Box component="div" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default', px: 1.5, py: 1 }}>
          <Typography component="dt" variant="metadata" color="text.secondary">交付形式</Typography>
          <Typography component="dd" variant="metadata" sx={{ mt: 0.5, ml: 0, fontWeight: 500 }}>{outputLabel}</Typography>
        </Box>
      </Box>
      <Typography component="p" variant="metadata" sx={{ mt: 1, lineHeight: 1.6, color: 'text.secondary' }}>
        任务会在后台继续；下方显示真实的研究轮次、已访问页面和可核对正文。资料数量不等于结论质量，未确认内容会单独标记。
      </Typography>
      <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1.5, rowGap: 0.5, typography: 'metadata' }}>
        <Typography component="span" variant="metadata" color="text.secondary">启动配置已锁定，避免运行中产生歧义。</Typography>
        <Link component={NextLink} href={`/ai-research/${jobId}`} underline="hover" sx={{ fontWeight: 500, color: 'primary.main' }}>
          打开任务并继续追问 →
        </Link>
      </Box>
    </Paper>
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
  const currentConversationIdRef = useRef<string | null>(conversationId ?? null);
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
  const loadedConversationIdRef = useRef<string | null>(null);
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());

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
    loadedConversationIdRef.current = null;
  }

  // 页面 URL 变化（例如点侧栏恢复对话）时同步当前会话。
  useEffect(() => {
    const nextConversationId = conversationId ?? null;
    const previousConversationId = previousConversationIdRef.current;
    // Leaving a conversation (to a new one or to a different saved one) must
    // drop every piece of the previous conversation's state. An id equal to the
    // one this component just created itself is not a switch.
    const switchedAway = nextConversationId !== currentConversationIdRef.current
      && (nextConversationId !== null || previousConversationId !== null);
    if (switchedAway) resetForNewConversation();
    previousConversationIdRef.current = nextConversationId;
    currentConversationIdRef.current = nextConversationId;
    setCurrentConversationId(nextConversationId);
  }, [conversationId]);

  // 恢复持久化对话：先加载消息，再回放规划状态。
  useEffect(() => {
    if (!currentConversationId || loadedConversationIdRef.current === currentConversationId) return;
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
        loadedConversationIdRef.current = conversation.id;
        const state = replayState(restored);
        setTopic(state.topic);
        setContext(state.context);
        setPhase(state.phase);
        setActiveJobId(conversation.jobId ?? null);
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
    const targetId = currentConversationId;
    persistenceQueueRef.current = persistenceQueueRef.current.then(async () => {
      try {
        const response = await fetch(`/api/ai-research/conversations/${encodeURIComponent(targetId)}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: entries }),
        });
        if (!response.ok) throw new Error(`persist failed: ${response.status}`);
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[ai-research] persist messages failed', err);
        if (currentConversationIdRef.current === targetId) {
          setError('对话保存失败，本次内容仍保留在当前页面，请暂勿刷新。');
        }
      }
    });
    await persistenceQueueRef.current;
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
      loadedConversationIdRef.current = conversation.id;
      currentConversationIdRef.current = conversation.id;
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

    if (!currentConversationId) {
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
    if (submitting || activeJobId || conversationCreating || hydrating) return;
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
            idempotencyKey: createUuid(),
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
            idempotencyKey: createUuid(),
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
    <Paper component="section" variant="outlined" sx={{ overflow: 'hidden' }} aria-label="AI 调研对话">
      <Box component="header" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 2, borderBottom: 1, borderColor: 'divider', px: { xs: 2, sm: 2.5 }, py: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box component="span" sx={{ display: 'grid', width: 32, height: 32, flexShrink: 0, placeItems: 'center', borderRadius: 1, color: 'primary.main', bgcolor: 'primary.light' }}>
            <Sparkles size={16} />
          </Box>
          <Box>
            <Typography variant="listTitle" component="h2">调研对话</Typography>
            <Typography variant="metadata" color="text.secondary">对话会自动保存，刷新后仍可继续。</Typography>
          </Box>
        </Box>
        <StepStepper step={stepIndex} />
      </Box>

      <Box sx={{ display: 'flex', minHeight: 0, flexDirection: 'column' }}>
        <Box
          ref={scrollRef}
          sx={{ display: 'grid', minHeight: 320, flex: 1, gap: 2.5, overflowY: { xs: 'visible', lg: 'auto' }, maxHeight: { xs: 'none', lg: '70vh' }, px: { xs: 2.5, sm: 2.5 }, py: 2.5 }}
          aria-live="polite"
        >
          {hydrating ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, typography: 'body2', color: 'text.secondary' }}>
              <CircularProgress size={16} thickness={5} sx={{ color: 'primary.main' }} aria-hidden />
              正在恢复对话…
            </Box>
          ) : (
            <>
              {messages.map((message) => (
                <Box key={message.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexDirection: message.role === 'user' ? 'row-reverse' : 'row' }}>
                  <Box component="span" sx={{ mt: 0.5, display: 'grid', width: 28, height: 28, flexShrink: 0, placeItems: 'center', borderRadius: 1, bgcolor: message.role === 'assistant' ? 'action.selected' : 'action.hover', color: message.role === 'assistant' ? 'primary.main' : 'text.secondary' }}>
                    {message.role === 'assistant' ? <Bot size={14} /> : <UserRound size={14} />}
                  </Box>
                  <Box sx={{ minWidth: 0, maxWidth: '86%', flex: message.role === 'user' ? '0 1 auto' : 1, textAlign: message.role === 'user' ? 'right' : 'left' }}>
                    <Typography component="span" variant="metadata" sx={{ mb: 0.5, display: 'block', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: message.role === 'assistant' ? 'primary.main' : 'text.secondary' }}>
                      {message.role === 'assistant' ? 'AI 调研助手' : '你'}
                    </Typography>
                    <Typography component="p" variant="reading" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {message.content}
                    </Typography>
                  </Box>
                </Box>
              ))}

              {phase === 'understand' && messages.length === 1 ? (
                <Box sx={{ ml: 5, pt: 0.5 }}>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                    {EXAMPLE_PROMPTS.map((example) => (
                      <Button
                        key={example}
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => processUserMessage(example)}
                        sx={{ minHeight: 44, borderRadius: 999, borderColor: 'divider', bgcolor: 'background.paper', px: 1.5, py: 1, typography: 'metadata', color: 'text.secondary', transition: (theme) => theme.transitions.create(['background-color', 'border-color', 'color']), '&:hover': { borderColor: 'primary.main', bgcolor: 'action.selected', color: 'text.primary' } }}
                      >
                        {example}
                      </Button>
                    ))}
                  </Box>
                </Box>
              ) : null}

              {phase !== 'understand' && !activeJobId ? (
                <Box sx={{ ml: 5 }}>
                  <AiResearchBrief
                    question={topic}
                    context={context}
                    topicHint={topicIdQuery ?? undefined}
                    startAction={(
                      <Button
                        type="button"
                        size="sm"
                        aria-label="开始调研"
                        onClick={() => void submit()}
                        disabled={submitting || conversationCreating || hydrating || scopeIncomplete || sourceSelectionIncomplete}
                      >
                        {submitting ? <CircularProgress size={16} thickness={5} aria-hidden /> : <Send size={16} />}
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
                </Box>
              ) : null}

              {phase === 'refine' && !activeJobId ? (
                <Box sx={{ ml: 5, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                  <Button type="button" variant="outline" size="xs" onClick={() => processUserMessage('跳过')} disabled={submitting || !!activeJobId}>
                    跳过背景
                  </Button>
                </Box>
              ) : null}

              {activeJobId ? (
                <Box sx={{ ml: 5, display: 'grid', gap: 1.5 }}>
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
                </Box>
              ) : null}
            </>
          )}
        </Box>

        {error ? (
          <Box role="alert" sx={{ mx: 2.5, mb: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, border: 1, borderColor: 'error.main', borderRadius: 1, bgcolor: 'var(--dr-color-danger-container)', px: 1.5, py: 1, typography: 'body2', color: 'error.main' }}>
            <Box component="span" sx={{ flex: 1 }}>{error}</Box>
            {canConfigure && !activeJobId ? <Button type="button" variant="outline" size="xs" onClick={() => void submit()}>重试</Button> : null}
            {loginRequired ? (
              <Link component={NextLink} href="/signin?callbackUrl=%2Fai-research" underline="always" sx={{ typography: 'metadata', fontWeight: 500, textUnderlineOffset: 2 }}>
                登录后继续
              </Link>
            ) : null}
          </Box>
        ) : null}

        <Box component="form" data-ai-research-form onSubmit={handleMessageSubmit} sx={{ borderTop: 1, borderColor: 'divider', bgcolor: 'background.paper', p: 2 }}>
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper', transition: 'border-color 120ms ease-out, box-shadow 120ms ease-out', '&:focus-within': { borderColor: 'primary.main', boxShadow: (theme) => `0 0 0 2px ${theme.palette.primary.main}22` } }}>
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
              maxLength={20_000}
              aria-label="AI 调研对话输入"
              disabled={submitting || conversationCreating || hydrating || !!activeJobId}
              sx={{ '& .MuiOutlinedInput-root': { minHeight: 92, bgcolor: 'transparent', boxShadow: 'none', '& fieldset': { border: 0 } }, '& textarea': { resize: 'none' } }}
            />
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5, px: 1.5, pb: 1.5 }}>
              <Typography component="span" variant="metadata" color="text.secondary">
                {activeJobId ? '请在完整任务页追问' : `⌘/Ctrl + Enter 发送 · ${input.length}/20000`}
              </Typography>
              <Button type="submit" size="sm" disabled={!input.trim() || submitting || conversationCreating || hydrating || !!activeJobId} aria-label="发送消息（AI 调研）">
                <Send size={14} />
                发送
              </Button>
            </Box>
          </Box>
        </Box>
      </Box>
    </Paper>
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
    <Box sx={{ display: 'grid', gap: 2 }} aria-label="资料与产出">
      <Box component="fieldset" disabled={disabled} sx={{ display: 'grid', gap: 1, m: 0, p: 0, border: 0, minWidth: 0, '&:disabled': { opacity: 0.5 } }}>
        <Box component="legend" sx={{ mb: 1, p: 0, fontWeight: 500, color: 'text.primary' }}>交付形式</Box>
        <Typography component="p" variant="metadata" sx={{ lineHeight: 1.6, color: 'text.secondary' }}>选择这次要生成的结果。</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 1 }}>
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
                sx={{ height: 'auto', minHeight: 48, justifyContent: 'flex-start', whiteSpace: 'normal', px: 1.5, py: 1, textAlign: 'left' }}
              >
                <Icon size={14} />
                <Box component="span" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left' }}>
                  <Typography component="span" variant="metadata" sx={{ fontWeight: 500 }}>{option.label}</Typography>
                  <Typography component="span" variant="metadata" color="text.secondary">{option.description}</Typography>
                </Box>
              </Button>
              );
            })}
        </Box>
        {quickJudgmentOption ? (() => {
          const Icon = quickJudgmentOption.icon;
          const selected = reportType === quickJudgmentOption.value;
          return (
            <Paper variant="outlined" sx={{ borderStyle: 'dashed', bgcolor: 'action.hover', px: 1.5, py: 1 }}>
              <Typography component="p" variant="metadata" sx={{ fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'text.secondary' }}>只想先看方向？</Typography>
              <Button
                type="button"
                variant={selected ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={selected}
                onClick={() => onReportTypeChange(quickJudgmentOption.value)}
                sx={{ mt: 0.5, height: 'auto', width: '100%', justifyContent: 'flex-start', whiteSpace: 'normal', px: 1, py: 1, textAlign: 'left' }}
              >
                <Icon size={14} />
                <Box component="span" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left' }}>
                  <Typography component="span" variant="metadata" sx={{ fontWeight: 500 }}>{quickJudgmentOption.label}</Typography>
                  <Typography component="span" variant="metadata" color="text.secondary">{quickJudgmentOption.description}；不会创建正式研究稿</Typography>
                </Box>
              </Button>
            </Paper>
          );
        })() : null}
      </Box>

      {reportType !== 'summary_brief' ? (
        <Box component="fieldset" disabled={disabled} sx={{ display: 'grid', gap: 1, m: 0, p: 0, border: 0, minWidth: 0, '&:disabled': { opacity: 0.5 } }}>
          <Box component="legend" sx={{ mb: 1, p: 0, fontWeight: 500, color: 'text.primary' }}>研究深度</Box>
          <Typography component="p" variant="metadata" sx={{ lineHeight: 1.6, color: 'text.secondary' }}>
            需要快速扫清方向，还是先覆盖多个角度，再根据证据缺口继续查？
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1 }}>
            <Button
              type="button"
              variant={reportLength === 'deep' ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={reportLength === 'deep'}
              onClick={() => onReportLengthChange('deep')}
              sx={{ height: 'auto', justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }}
            >
              <Box component="span" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <Typography component="span" variant="metadata" sx={{ fontWeight: 500 }}>多轮研究 · 推荐</Typography>
                <Typography component="span" variant="metadata" sx={{ fontWeight: 400, color: 'text.secondary' }}>先覆盖多个方向，再补查真实证据缺口；适合重要判断，耗时更长</Typography>
              </Box>
            </Button>
            <Button
              type="button"
              variant={reportLength === 'standard' ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={reportLength === 'standard'}
              onClick={() => onReportLengthChange('standard')}
              sx={{ height: 'auto', justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }}
            >
              <Box component="span" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <Typography component="span" variant="metadata" sx={{ fontWeight: 500 }}>单轮研究</Typography>
                <Typography component="span" variant="metadata" sx={{ fontWeight: 400, color: 'text.secondary' }}>只做一轮检索，适合先扫清方向，不适合证据要求很高的决策</Typography>
              </Box>
            </Button>
          </Box>
          {reportLength === 'deep' && sourcePolicy !== 'only_user_sources' ? (
            <Paper variant="outlined" sx={{ borderColor: 'primary.main', bgcolor: 'action.selected', px: 1.5, py: 1, typography: 'metadata', lineHeight: 1.6, color: 'text.secondary' }}>
              <Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>这次会做：</Box>
              拆分问题 → 并行检索 → 根据缺口补查 → 生成结果。
              证据足够时会提前收敛，不会为了凑页数继续搜索。
            </Paper>
          ) : null}
          {reportLength === 'deep' && sourcePolicy === 'only_user_sources' ? (
            <Typography component="p" variant="metadata" sx={{ lineHeight: 1.6, color: 'text.secondary' }}>
              当前只使用你提供的资料；不会扩展到网页做多轮检索。
            </Typography>
          ) : null}
        </Box>
      ) : null}

      <Box component="fieldset" disabled={disabled} sx={{ display: 'grid', gap: 1, m: 0, p: 0, border: 0, minWidth: 0, '&:disabled': { opacity: 0.5 } }}>
        <Box component="legend" sx={{ mb: 1, p: 0, fontWeight: 500, color: 'text.primary' }}>资料来源</Box>
        <Typography component="p" variant="metadata" sx={{ lineHeight: 1.6, color: 'text.secondary' }}>决定 AI 可以参考哪些资料。</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1 }}>
          <Button type="button" aria-pressed={sourcePolicy === 'prefer_user_sources'} variant={sourcePolicy === 'prefer_user_sources' ? 'secondary' : 'outline'} size="sm" onClick={() => onSourcePolicyChange('prefer_user_sources')} sx={{ height: 'auto', justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }}>
            <Box component="span" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <Typography component="span" variant="metadata" sx={{ fontWeight: 500 }}>网页搜索 + 已选资料</Typography>
              <Typography component="span" variant="metadata" sx={{ fontWeight: 400, color: 'text.secondary' }}>搜索公开网页；你选中的资料也会一并纳入</Typography>
            </Box>
          </Button>
          <Button type="button" aria-pressed={sourcePolicy === 'only_user_sources'} variant={sourcePolicy === 'only_user_sources' ? 'secondary' : 'outline'} size="sm" onClick={() => onSourcePolicyChange('only_user_sources')} sx={{ height: 'auto', justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }}>
            <Box component="span" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <Typography component="span" variant="metadata" sx={{ fontWeight: 500 }}>仅使用已选资料</Typography>
              <Typography component="span" variant="metadata" sx={{ fontWeight: 400, color: 'text.secondary' }}>不访问公开网页，只使用你添加的资料</Typography>
            </Box>
          </Button>
        </Box>
        <Paper variant="outlined" sx={{ bgcolor: 'action.hover', px: 1.5, py: 1, typography: 'metadata', lineHeight: 1.6, color: 'text.secondary' }}>
          <Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>已添加资料：</Box>
          {sourceRefs.length > 0 ? `${sourceRefs.length} 条${seed ? '（含当前雷达内容）' : ''}` : '尚未添加'}
          {selectedContextCount > 0 ? ` · ${selectedContextCount} 条已有资料` : ''}
        </Paper>
        <Box component="label" htmlFor="conversation-source-url" sx={{ display: 'grid', gap: 1 }}>
          <Typography component="span" variant="metadata" color="text.secondary">添加网页资料（可选）</Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
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
              sx={{ minWidth: 0, '& .MuiOutlinedInput-root': { height: 32, minHeight: 32 }, '& .MuiOutlinedInput-input': { py: 0.5, fontSize: 'var(--dr-type-caption)' } }}
            />
            <Button type="button" variant="outline" size="icon-sm" onClick={onAddSource} aria-label="添加网页资料">
              <Link2 size={14} />
            </Button>
          </Box>
        </Box>
        {sourceUrls.length > 0 ? (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {sourceUrls.map((url) => (
              <Button
                key={url}
                type="button"
                variant="outline"
                size="xs"
                onClick={() => onRemoveSource(url)}
                sx={{ display: 'inline-flex', maxWidth: '100%', minHeight: 32, alignItems: 'center', gap: 0.5, borderColor: 'divider', bgcolor: 'background.paper', px: 1, py: 0.5, typography: 'metadata', color: 'text.secondary', '&:hover': { color: 'text.primary' } }}
                title={`移除资料 ${url}`}
              >
                <Box component="span" sx={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</Box>
                <X size={12} />
              </Button>
            ))}
          </Box>
        ) : null}
      </Box>

      {scopeIncomplete ? (
        <Box component="p" role="alert" sx={{ border: 1, borderColor: 'warning.main', borderRadius: 1, bgcolor: 'var(--dr-color-warning-container)', px: 1.5, py: 1, typography: 'metadata', lineHeight: 1.6, color: 'warning.main' }}>
          “优先资料时间”选择了自定义，请同时填写开始和结束日期后再启动。
        </Box>
      ) : null}

      <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
        {sourceSelectionIncomplete ? (
          <Box component="p" role="alert" sx={{ mb: 1, border: 1, borderColor: 'warning.main', borderRadius: 1, bgcolor: 'var(--dr-color-warning-container)', px: 1.5, py: 1, typography: 'metadata', lineHeight: 1.6, color: 'warning.main' }}>
            仅使用已选资料时，请先添加至少一条雷达内容、网页资料或已有资料。
          </Box>
        ) : null}
        <Typography component="p" variant="metadata" sx={{ lineHeight: 1.6, color: 'text.secondary' }}>
          {
            sourceSelectionIncomplete
              ? '添加资料后，“开始研究”按钮会恢复可用。'
              : '这些选择会和上面的研究方案一起提交；点击“开始研究”后将锁定。'}
        </Typography>
      </Box>
    </Box>
  );
}
