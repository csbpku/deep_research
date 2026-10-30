'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import NextLink from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Check,
  FileText,
  Globe2,
  Link2,
  Presentation,
  Send,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';

import { ResearchConfirmationControls } from './ResearchConfirmationControls';
import { readResearchDraft, writeResearchDraft } from '@/lib/ai-research-state';
import { InlineAiResearchStatus } from '@/components/ai-research/InlineAiResearchStatus';
import { AiResearchBrief, type BriefValue } from '@/components/ai-research/AiResearchBrief';
import { AiResearchButton as Button, AiResearchTextarea as Textarea } from '@/components/ai-research/AiResearchMaterial';
import { AppTextField as Input } from '@/components/material/AppTextField';
import MarkdownContent from '@/components/MarkdownContent';
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
import type { AiResearchChatMessage, AiResearchConversationDetail, FollowUpIntent } from '@/lib/ai-research-chat';
import { stripResearchCitationMarkers } from '@/lib/ai-research-state';
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

const FOLLOW_UP_SHORTCUTS: Array<{ intent: FollowUpIntent; label: string }> = [
  { intent: 'answer', label: '继续问答' },
  { intent: 'verify', label: '核验证据' },
  { intent: 'revise', label: '修订建议' },
  { intent: 'action', label: '生成行动项' },
];

interface Message {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  intent?: AiResearchChatMessage['intent'];
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

/** 顶部阶段 stepper：理解 → 补全 → 启动 → 进行中/已完成。 */
const STEP_LABELS = ['明确问题', '确认设置', '启动研究', '进行中'] as const;

function StepStepper({ step, finished = false }: { step: number; finished?: boolean }) {
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
              {index === STEP_LABELS.length - 1 && finished ? '已完成' : label}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

function ResearchRunReceipt({ jobId, topic }: { jobId: string; topic: string }) {
  const [receipt, setReceipt] = useState<{ reportLength: ResearchLength; reportType: ReportType; sourcePolicy: SourcePolicy; sourceCount: number } | null>(null);
  const [receiptError, setReceiptError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setReceipt(null); setReceiptError(false);
    void fetch(`/api/ai-research/${encodeURIComponent(jobId)}`, { cache: 'no-store' })
      .then(async (response) => { if (!response.ok) throw new Error('receipt unavailable'); return await response.json() as Record<string, unknown>; })
      .then((data) => {
        if (cancelled) return;
        if (!['research_report', 'summary_brief', 'slides', 'web_brief'].includes(String(data.reportType)) ||
            !['brief', 'standard', 'deep'].includes(String(data.reportLength)) ||
            !['prefer_user_sources', 'only_user_sources'].includes(String(data.sourcePolicy))) throw new Error('receipt incomplete');
        setReceipt({ reportType: data.reportType as ReportType, reportLength: data.reportLength as ResearchLength,
          sourcePolicy: data.sourcePolicy as SourcePolicy, sourceCount: Array.isArray(data.sourceRefs) ? data.sourceRefs.length : 0 });
      }).catch(() => { if (!cancelled) setReceiptError(true); });
    return () => { cancelled = true; };
  }, [jobId, attempt]);
  if (!receipt) return <Paper component="section" aria-label="本次研究收据" variant="outlined" sx={{ p: 2 }}>
    {receiptError ? <>暂时无法确认启动配置。 <Button type="button" onClick={() => setAttempt((n) => n + 1)}>重新读取配置</Button></> : '正在读取已提交的研究配置…'}
  </Paper>;
  const { reportLength, reportType, sourcePolicy, sourceCount } = receipt;
  const selectedContextCount = 0;
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
          {reportLength === 'brief' ? '快速判断' : isDeep ? '多轮研究' : '单轮研究'}
        </Box>
      </Box>
      <Box component="dl" sx={{ mt: 1.5, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 1, typography: 'metadata' }}>
        <Box component="div" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default', px: 1.5, py: 1 }}>
          <Typography component="dt" variant="metadata" color="text.secondary">研究深度</Typography>
          <Typography component="dd" variant="metadata" sx={{ mt: 0.5, ml: 0, fontWeight: 500 }}>{reportLength === 'brief' ? '快速判断，不进行完整检索' : isDeep ? '多轮覆盖，缺口再追查' : '先完成一轮检索'}</Typography>
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
        <Link href="#ai-research-result" underline="hover" sx={{ fontWeight: 500, color: 'primary.main' }}>
          结果和追问都在本对话中 ↓
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

// Synchronous durable marker: set before sending so a reload or lost response
// cannot silently make a second, chargeable request available.
function pendingSubmissionKey(userId: string, conversationId: string): string {
  return `ai-research-pending:v1:${userId}:${conversationId}`;
}
function markPending(userId: string, conversationId: string): boolean {
  try {
    const key = pendingSubmissionKey(userId, conversationId);
    window.localStorage.setItem(key, 'pending');
    return window.localStorage.getItem(key) === 'pending';
  } catch { return false; }
}
// A completed marker lets a stale tab resume the existing job even after the
// tab that submitted it has released its lock.
function readSubmissionMarker(userId: string, conversationId: string): string | null | undefined {
  try { return window.localStorage.getItem(pendingSubmissionKey(userId, conversationId)); }
  catch { return undefined; }
}
function markSubmitted(userId: string, conversationId: string, jobId: string): void {
  try { window.localStorage.setItem(pendingSubmissionKey(userId, conversationId), `job:${jobId}`); }
  catch { /* Preserve the pending marker and require history verification. */ }
}
function readPending(userId: string, conversationId: string): boolean | null {
  try { return window.localStorage.getItem(pendingSubmissionKey(userId, conversationId)) !== null; }
  catch { return null; }
}
function clearPending(userId: string, conversationId: string): boolean {
  try {
    const key = pendingSubmissionKey(userId, conversationId);
    window.localStorage.removeItem(key);
    return window.localStorage.getItem(key) === null;
  } catch { return false; }
}

interface InlineJobSnapshot {
  jobId: string;
  status: string;
  finalStatus: string | null;
  outputText: string | null;
  reportType: string | null;
  reportLength?: 'brief' | 'standard' | 'deep';
  deliverableStatus?: 'report' | 'evidence_only' | 'none';
  draftResearchId: string | null;
  artifact: { content: string | null } | null;
}

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'partial']);

export function AiResearchConversation({
  conversationId,
  fromJobId = null,
  jobId = null,
}: {
  conversationId?: string | null;
  fromJobId?: string | null;
  jobId?: string | null;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
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
  const [errorKind, setErrorKind] = useState<'save' | 'submit' | 'restore' | 'validation' | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [restoredBrief, setRestoredBrief] = useState<BriefValue | null>(null);
  const [draftStorageError, setDraftStorageError] = useState(false);
  const [submissionUncertain, setSubmissionUncertain] = useState(false);
  const [followUpSending, setFollowUpSending] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [followUpIntent, setFollowUpIntent] = useState<FollowUpIntent>('answer');
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousConversationIdRef = useRef<string | null>(conversationId ?? null);
  const loadedConversationIdRef = useRef<string | null>(null);
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const fromJobAppliedRef = useRef(false);
  const jobRouteResolvedRef = useRef(false);

  // Task history, the topbar and old /ai-research/<jobId> links all land here.
  // Resolve the job to its conversation instead of rendering a separate
  // result page; jobs created outside the chat get a conversation on demand.
  useEffect(() => {
    if (!jobId || conversationId || jobRouteResolvedRef.current) return;
    jobRouteResolvedRef.current = true;
    let cancelled = false;
    setHydrating(true);
    void (async () => {
      const existing = await fetch(`/api/ai-research/conversations/by-job/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      if (cancelled) return;
      if (existing.ok) {
        const conversation = await existing.json() as AiResearchConversationDetail;
        router.replace(`/ai-research?conversation=${conversation.id}`, { scroll: false });
        return;
      }
      if (existing.status !== 404) throw await toApiHttpError(existing, '读取调研对话失败');
      const detail = await fetch(`/api/ai-research/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      if (!detail.ok) throw await toApiHttpError(detail, '读取调研任务失败');
      if (cancelled) return;
      const job = await detail.json() as { topic?: string | null };
      const topicText = typeof job.topic === 'string' ? job.topic : 'AI 调研';
      const created = await fetch('/api/ai-research/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: topicText.slice(0, 200),
          jobId,
          messages: [
            { role: 'user', content: topicText },
            { role: 'assistant', content: '这次调研已结束，结果、证据和追问都在本对话中。' },
          ],
        }),
      });
      if (!created.ok) throw await toApiHttpError(created, '创建调研对话失败');
      if (cancelled) return;
      const conversation = await created.json() as AiResearchConversationDetail;
      router.replace(`/ai-research?conversation=${conversation.id}`, { scroll: false });
    })().catch((err: unknown) => {
      if (!cancelled) {
        setErrorKind('restore');
        setError(friendlyMessage(err, '无法打开这条调研，请从任务历史重试。'));
      }
    }).finally(() => {
      if (!cancelled) setHydrating(false);
    });
    return () => {
      cancelled = true;
      jobRouteResolvedRef.current = false;
    };
  }, [conversationId, jobId, router]);

  // "调整配置后重跑" navigates here with the failed job id. Rebuild the
  // submit form from that job so the user edits the previous research
  // instead of retyping it into a blank conversation.
  useEffect(() => {
    if (!fromJobId || conversationId || fromJobAppliedRef.current) return;
    fromJobAppliedRef.current = true;
    let cancelled = false;
    setHydrating(true);
    void fetch(`/api/ai-research/${encodeURIComponent(fromJobId)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw await toApiHttpError(response, '读取原调研配置失败');
        return await response.json() as Record<string, unknown>;
      })
      .then((data) => {
        if (cancelled) return;
        const restoredTopic = typeof data.topic === 'string' ? data.topic : '';
        const restoredContext = typeof data.context === 'string' ? data.context : '';
        const restoredType = ['research_report', 'summary_brief', 'slides', 'web_brief'].includes(String(data.reportType))
          ? data.reportType as ReportType
          : 'research_report';
        const restoredLength = ['brief', 'standard', 'deep'].includes(String(data.reportLength))
          ? data.reportLength as ResearchLength
          : restoredType === 'summary_brief' ? 'brief' : 'deep';
        const restoredPolicy = data.sourcePolicy === 'only_user_sources' ? 'only_user_sources' : 'prefer_user_sources';
        const restoredUrls = Array.isArray(data.sourceRefs)
          ? (data.sourceRefs as Array<Record<string, unknown>>)
            .filter((ref) => ref.type === 'url')
            .map((ref) => (typeof ref.value === 'string' ? ref.value : ''))
            .filter((url) => /^https?:\/\//iu.test(url))
          : [];
        setTopic(restoredTopic);
        setContext(restoredContext);
        setInput(restoredTopic);
        setReportType(restoredType);
        setReportLength(restoredLength);
        setSourcePolicy(restoredPolicy);
        setSourceUrls(restoredUrls);
        setBrief(null);
        setRestoredBrief(null);
        setActiveJobId(null);
        setPhase('ready');
        setMessages([
          {
            id: newId('assistant'),
            role: 'assistant',
            content: '已载入上次调研的问题和设置。可以直接重新开始，或先调整研究类型、深度和资料范围。',
          },
          ...(restoredTopic ? [{ id: newId('user'), role: 'user' as const, content: restoredTopic }] : []),
        ]);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setErrorKind('restore');
          setError(friendlyMessage(err, '无法载入上次调研配置，请重新填写。'));
        }
      })
      .finally(() => {
        if (!cancelled) setHydrating(false);
      });
    return () => { cancelled = true; };
  }, [fromJobId, conversationId]);

  const activeJobQuery = useQuery<InlineJobSnapshot>({
    queryKey: ['inline-ai-research', activeJobId],
    enabled: Boolean(activeJobId),
    queryFn: async () => {
      const response = await fetch(`/api/ai-research/${encodeURIComponent(activeJobId ?? '')}`, { cache: 'no-store' });
      if (!response.ok) throw await toApiHttpError(response, '读取调研状态失败');
      return await response.json() as InlineJobSnapshot;
    },
    refetchInterval: (query) => {
      const snapshot = query.state.data;
      const status = snapshot?.finalStatus ?? snapshot?.status;
      return status && TERMINAL_JOB_STATUSES.has(status) ? false : 5_000;
    },
  });
  const activeJobStatus = activeJobQuery.data?.finalStatus ?? activeJobQuery.data?.status;
  const activeJobTerminal = Boolean(activeJobStatus && TERMINAL_JOB_STATUSES.has(activeJobStatus));
  const activeJobHasReport = Boolean(
    activeJobQuery.data?.artifact?.content || activeJobQuery.data?.outputText,
  ) && activeJobQuery.data?.deliverableStatus !== 'evidence_only';
  const activeJobConversationQuery = useQuery<AiResearchConversationDetail | null>({
    queryKey: ['ai-research-conversation', activeJobId],
    enabled: Boolean(activeJobId) && activeJobTerminal && activeJobHasReport,
    retry: false,
    queryFn: async () => {
      const response = await fetch(`/api/ai-research/conversations/by-job/${encodeURIComponent(activeJobId ?? '')}`, { cache: 'no-store' });
      // Jobs created outside the chat (radar, imports) have no conversation
      // yet. That is not an error: the first follow-up creates one.
      if (response.status === 404) return null;
      if (!response.ok) throw await toApiHttpError(response, '追问对话不可读');
      return await response.json() as AiResearchConversationDetail;
    },
  });

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
    setRestoredBrief(null);
    setOwnerId(null);
    setDraftStorageError(false);
    setSubmissionUncertain(false);
    setFollowUpSending(false);
    setFollowUpError(null);
    setErrorKind(null);
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
          ...(message.intent ? { intent: message.intent } : {}),
        }));
        setMessages(restored);
        loadedConversationIdRef.current = conversation.id;
        const state = replayState(restored);
        setTopic(state.topic);
        setContext(state.context);
        setPhase(state.phase);
        setActiveJobId(conversation.jobId ?? null);
        const owner = conversation.userId ?? null;
        setOwnerId(owner);
        if (owner && conversation.jobId) markSubmitted(owner, conversation.id, conversation.jobId);
        if (owner && !conversation.jobId) {
          const marker = readSubmissionMarker(owner, conversation.id);
          const pending = readPending(owner, conversation.id);
          if (marker?.startsWith('job:') && marker.length > 4) {
            setActiveJobId(marker.slice(4));
            setSubmissionUncertain(false);
            setError(null); setErrorKind(null);
          } else if (pending !== false) {
            setSubmissionUncertain(true);
            setErrorKind('submit');
            setError(pending === null ? '无法读取浏览器存储，暂时不能确认上次提交状态。请先查看任务历史。' : '上次提交结果尚未确认，请先查看任务历史。');
          }
          let draft: ReturnType<typeof readResearchDraft> = null;
          try { draft = readResearchDraft(window.localStorage, owner, conversation.id); } catch { setDraftStorageError(true); }
          if (draft) {
            setReportType(draft.reportType); setReportLength(draft.reportLength);
            setSourcePolicy(draft.sourcePolicy); setSourceUrls(draft.sourceUrls);
            setSourceDraft(draft.sourceDraft); setInput(draft.input); setSeed(draft.seed ?? null);
            setBrief(draft.brief); setRestoredBrief(draft.brief);
          }
        }
        if (conversation.jobId || !owner || readPending(owner, conversation.id) === false) setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) { setErrorKind('restore'); setError(friendlyMessage(err, '对话恢复失败，请重新打开此对话。')); }
      })
      .finally(() => {
        if (!cancelled) setHydrating(false);
      });
    return () => { cancelled = true; };
  }, [currentConversationId]);

  useEffect(() => {
    if (!ownerId || !currentConversationId) return;
    const key = pendingSubmissionKey(ownerId, currentConversationId);
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage || event.key !== key) return;
      if (event.newValue?.startsWith('job:') && event.newValue.length > 4) {
        setActiveJobId(event.newValue.slice(4));
        setSubmissionUncertain(false);
        setError(null);
        setErrorKind(null);
      } else if (event.newValue !== null) {
        setSubmissionUncertain(true);
        setErrorKind('submit');
        setError('另一标签页的提交结果尚未确认，请先查看任务历史。');
      } else {
        setSubmissionUncertain(false);
        setErrorKind((current) => current === 'submit' ? null : current);
        setError((current) => current?.includes('提交结果尚未确认') ? null : current);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [ownerId, currentConversationId]);

  useEffect(() => {
    if (!ownerId || !currentConversationId || hydrating || activeJobId) return;
    try {
      setDraftStorageError(!writeResearchDraft(window.localStorage, ownerId, currentConversationId, {
        reportType, reportLength, sourcePolicy, sourceUrls, sourceDraft, input, seed, brief,
      }));
    } catch { setDraftStorageError(true); }
  }, [ownerId, currentConversationId, hydrating, activeJobId, reportType, reportLength, sourcePolicy, sourceUrls, sourceDraft, input, seed, brief]);

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
          setErrorKind('save');
          setError('对话保存失败，本次内容仍保留在当前页面，请暂勿刷新。');
        }
      }
    });
    await persistenceQueueRef.current;
  }

  async function createConversation(title: string, currentMessages: Message[]): Promise<AiResearchConversationDetail | null> {
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
      setOwnerId(conversation.userId ?? null);
      currentConversationIdRef.current = conversation.id;
      setCurrentConversationId(conversation.id);
      setMessages(conversation.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
      })));
      router.replace(`/ai-research?conversation=${conversation.id}`, { scroll: false });
      return conversation;
    } catch (err) {
      setErrorKind('save');
      setError(friendlyMessage(err, '对话暂存失败，本次内容仍保留在当前页面。'));
      return null;
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
    if (composerMode === 'followup') {
      void sendFollowUp(input);
      return;
    }
    processUserMessage(input);
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (composerMode === 'followup') {
        void sendFollowUp(input);
        return;
      }
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

  async function allowRetryAfterHistory() {
    if (!ownerId || !currentConversationId || !navigator.locks?.request) {
      setError('无法取得防重复提交锁，请使用支持 Web Locks 的浏览器后重试。');
      return;
    }
    try {
      await navigator.locks.request(pendingSubmissionKey(ownerId, currentConversationId), { ifAvailable: true }, (lock) => {
        if (!lock) {
          setError('另一标签页仍在提交，请等待结果后再核对历史。');
          return;
        }
        const marker = readSubmissionMarker(ownerId, currentConversationId);
        if (marker?.startsWith('job:') && marker.length > 4) {
          setActiveJobId(marker.slice(4)); setSubmissionUncertain(false); setError(null); setErrorKind(null);
        } else if (marker !== undefined && clearPending(ownerId, currentConversationId)) {
          setSubmissionUncertain(false); setError(null); setErrorKind(null);
        } else setError('无法更新浏览器存储，请允许本地存储后再试。');
      });
    } catch { setError('无法取得防重复提交锁，请刷新页面后重试。'); }
  }

  async function submit(extraMessages: Message[] = []) {
    if (submitting || activeJobId || conversationCreating || hydrating || submissionUncertain) return;
    if (topic.trim().length < 2) {
      setErrorKind('validation');
      setError('先告诉我至少 2 个字的研究主题。');
      return;
    }
    if (brief?.contextSelectionIncomplete) {
      setErrorKind('validation');
      setError('旧草稿的部分资料无法确认对应来源，请取消其余旧资料后重新选择。');
      return;
    }
    const effectiveSourceRefs = mergeSourceRefs(sourceRefs, brief?.brief?.contextRefs ?? [], sourcePolicy);
    if (sourcePolicy === 'only_user_sources' && effectiveSourceRefs.length === 0) {
      setErrorKind('validation');
      setError('只使用指定资料时，至少需要一条雷达内容或网页资料。');
      return;
    }
    const selectedScope = brief?.brief?.scope;
    if (selectedScope?.timeRange.preset === 'custom') {
      if (!selectedScope.timeRange.from || !selectedScope.timeRange.to) {
        setErrorKind('validation');
        setError('自定义时间范围需要同时填写开始和结束日期。');
        return;
      }
      if (selectedScope.timeRange.from > selectedScope.timeRange.to) {
        setErrorKind('validation');
        setError('自定义时间范围的结束日期不能早于开始日期。');
        return;
      }
    }
    setError(null);
    setSubmitting(true);
    let targetId = currentConversationId;
    let targetOwner = ownerId;
    if (!targetId || !targetOwner) {
      if (targetId) {
        setErrorKind('save'); setError('无法确认当前账户，请重新打开对话后再试。'); setSubmitting(false); return;
      }
      const created = await createConversation(topic.trim(), [...messages, ...extraMessages]);
      if (!created || !created.userId) { setSubmitting(false); return; }
      targetId = created.id; targetOwner = created.userId;
    }
    const lockOwner = targetOwner;
    const lockTarget = targetId;
    if (!navigator.locks?.request) {
      setErrorKind('validation');
      setError('此浏览器无法安全防止重复提交，请使用支持 Web Locks 的浏览器后重试。');
      setSubmitting(false); return;
    }
    try {
      await navigator.locks.request(pendingSubmissionKey(lockOwner, lockTarget), async () => {
        const existing = readSubmissionMarker(lockOwner, lockTarget);
        if (existing?.startsWith('job:') && existing.length > 4) {
          setActiveJobId(existing.slice(4));
          setSubmissionUncertain(false);
          setError(null); setErrorKind(null);
          return;
        }
        if (existing !== null) {
          setSubmissionUncertain(true);
          setErrorKind('submit');
          setError(existing === undefined ? '无法读取浏览器存储，暂时不能确认上次提交状态。请先查看任务历史。' : '上次提交结果尚未确认，请先查看任务历史。');
          return;
        }
        if (!markPending(lockOwner, lockTarget)) {
          setErrorKind('save');
          setError('无法保存防重复提交状态。请允许此浏览器使用本地存储后再启动研究。');
          return;
        }
        setSubmissionUncertain(true);
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
                conversationId: lockTarget,
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
                conversationId: lockTarget,
                conversation: conversationSnapshot,
              };

          const response = await fetch('/api/ai-research', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(submitBody),
          });
          if (!response.ok) {
            const uncertain = response.status >= 500 || response.status === 408;
            const cleared = !uncertain && clearPending(lockOwner, lockTarget);
            setErrorKind(uncertain || !cleared ? 'submit' : 'validation');
            if (cleared) setSubmissionUncertain(false);
            setError(friendlyMessage(await toApiHttpError(response, '提交结果未确认'), '提交结果未确认，请先查看任务历史。'));
            setMessages((current) => current.filter((message) => message.id !== placeholder.id));
            return;
          }
          const body = await response.json() as { jobId: string };
          markSubmitted(lockOwner, lockTarget, body.jobId);
          writeLastSubmitted(body.jobId, topic.trim());
          setActiveJobId(body.jobId);
          // The sidebar's recent-task list is a separate query; without this
          // it keeps showing the pre-submission snapshot.
          void queryClient.invalidateQueries({ queryKey: ['ai-research-jobs'] });
          const finalContent = '调研已启动。进度、来源和结果会持续显示在这里；完成后可以直接接着追问。';
          setMessages((current) => current.map((message) => (
            message.id === placeholder.id ? { ...message, content: finalContent } : message
          )));
          void persistMessages([{ role: 'assistant', content: finalContent }]);
        } catch (err) {
          setErrorKind('submit');
          setSubmissionUncertain(true);
          setError(friendlyMessage(err, '提交结果未确认，请先查看任务历史。'));
          setMessages((current) => current.filter((message) => message.id !== placeholder.id));
        }
      });
    } catch {
      setErrorKind('validation');
      setError('无法取得防重复提交锁，请刷新页面后重试。');
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Send a post-research question through the same conversation thread.
   *
   * The durable conversation already carries the research context, so the
   * follow-up uses that instead of creating a second "chat" surface. The
   * server persists both turns; this component only renders the stream.
   */
  async function sendFollowUp(raw: string): Promise<void> {
    const content = raw.trim();
    if (!content || !activeJobId || followUpSending) return;
    setInput('');
    setFollowUpError(null);
    setFollowUpSending(true);
    const userId = newId('followup-user');
    const assistantId = newId('followup-assistant');
    setMessages((current) => [
      ...current,
      { id: userId, role: 'user', content, intent: followUpIntent },
      { id: assistantId, role: 'assistant', content: '', intent: followUpIntent },
    ]);
    let accumulated = '';
    try {
      let conversationIdForJob = activeJobConversationQuery.data?.id;
      if (!conversationIdForJob) {
        const created = await fetch('/api/ai-research/conversations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: (topic || 'AI 调研').slice(0, 200),
            jobId: activeJobId,
            messages: messages.map(({ role, content: text }) => ({ role, content: text })).slice(0, 200),
          }),
        });
        if (!created.ok) throw await toApiHttpError(created, '追问会话创建失败');
        const detail = await created.json() as AiResearchConversationDetail;
        conversationIdForJob = detail.id;
        await activeJobConversationQuery.refetch();
      }
      const response = await fetch(
        `/api/ai-research/conversations/${encodeURIComponent(conversationIdForJob)}/messages/stream`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, intent: followUpIntent }),
        },
      );
      if (!response.ok || !response.body) {
        throw new Error(friendlyMessage(await toApiHttpError(response, '追问失败'), '追问失败，请稍后重试。'));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const lines = frame.split('\n');
          const dataLine = lines.find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          const eventLine = lines.find((line) => line.startsWith('event: '));
          const event = eventLine ? eventLine.slice(7).trim() : 'progress';
          if (event === 'error') {
            try {
              const payload = JSON.parse(dataLine.slice(6)) as { message?: unknown };
              if (typeof payload.message === 'string' && payload.message) {
                setFollowUpError(payload.message);
              }
            } catch {
              // A malformed error frame must not break the turn.
            }
            continue;
          }
          let payload: unknown;
          try {
            payload = JSON.parse(dataLine.slice(6));
          } catch {
            continue;
          }
          if (event === 'done') {
            // The done frame carries the authoritative full answer, so use it
            // instead of appending (which would duplicate the whole text).
            const complete = typeof payload === 'string'
              ? payload
              : payload && typeof payload === 'object' && typeof (payload as { content?: unknown }).content === 'string'
                ? (payload as { content: string }).content
                : '';
            if (complete) {
              accumulated = complete;
              setMessages((current) => current.map((message) => (
                message.id === assistantId ? { ...message, content: accumulated } : message
              )));
            }
            continue;
          }
          if (event !== 'delta') continue;
          const delta = typeof payload === 'string'
            ? payload
            : payload && typeof payload === 'object' && typeof (payload as { content?: unknown }).content === 'string'
              ? (payload as { content: string }).content
              : '';
          if (!delta) continue;
          accumulated += delta;
          setMessages((current) => current.map((message) => (
            message.id === assistantId ? { ...message, content: accumulated } : message
          )));
        }
      }
      if (activeJobConversationQuery.data) {
        void activeJobConversationQuery.refetch();
      }
    } catch (err) {
      setFollowUpError(friendlyMessage(err, '追问失败，请稍后重试。'));
      setMessages((current) => current.filter((message) => message.id !== userId && message.id !== assistantId));
    } finally {
      setFollowUpSending(false);
    }
  }

  /**
   * Rebuild the submit form from the finished job so the single "重新调研"
   * action returns to the same conversation with the previous configuration
   * already loaded and editable.
   */
  async function restartWithSameConfig(): Promise<void> {
    const jobId = activeJobId;
    if (!jobId) return;
    try {
      const response = await fetch(`/api/ai-research/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      if (!response.ok) throw await toApiHttpError(response, '读取原调研配置失败');
      const data = await response.json() as Record<string, unknown>;
      const restoredType = ['research_report', 'summary_brief', 'slides', 'web_brief'].includes(String(data.reportType))
        ? data.reportType as ReportType
        : 'research_report';
      const restoredUrls = Array.isArray(data.sourceRefs)
        ? (data.sourceRefs as Array<Record<string, unknown>>)
          .filter((ref) => ref.type === 'url')
          .map((ref) => (typeof ref.value === 'string' ? ref.value : ''))
          .filter((url) => /^https?:\/\//iu.test(url))
        : [];
      setTopic(typeof data.topic === 'string' ? data.topic : '');
      setContext(typeof data.context === 'string' ? data.context : '');
      setReportType(restoredType);
      setReportLength(['brief', 'standard', 'deep'].includes(String(data.reportLength))
        ? data.reportLength as ResearchLength
        : restoredType === 'summary_brief' ? 'brief' : 'deep');
      setSourcePolicy(data.sourcePolicy === 'only_user_sources' ? 'only_user_sources' : 'prefer_user_sources');
      setSourceUrls(restoredUrls);
      setActiveJobId(null);
      setPhase('ready');
      setBrief(null);
      setRestoredBrief(null);
      setFollowUpError(null);
      setMessages([
        {
          id: newId('assistant'),
          role: 'assistant',
          content: '已载入上次调研的问题和设置。可以确认后重新开始，也可以先调整研究类型、深度和资料范围。',
        },
      ]);
    } catch (err) {
      setFollowUpError(friendlyMessage(err, '无法载入上次调研配置，请重新填写。'));
    }
  }

  const scopeIncomplete = brief?.scopeValid === false;
  const sourceSelectionIncomplete = sourcePolicy === 'only_user_sources'
    && sourceRefs.length === 0
    && (brief?.suggestedContextIds.length ?? 0) === 0;
  const loginRequired = !!error && /登录|401|未认证/u.test(error);
  const stepIndex = activeJobId && !activeJobTerminal ? 3 : phase === 'understand' && !activeJobId ? 0 : activeJobId ? 4 : phase === 'refine' ? 1 : 2;
  // The composer has three jobs in one thread: shape the brief, wait for a
  // running job, then ask follow-ups about the finished report. Keeping one
  // input avoids a second "chat" surface competing with the conversation.
  const composerMode: 'plan' | 'running' | 'followup' | 'restart' = !activeJobId
    ? 'plan'
    : activeJobTerminal
      ? activeJobHasReport ? 'followup' : 'restart'
      : 'running';
  const showInlineFollowUp = composerMode === 'followup';
  const visibleMessages = messages;

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
            <Typography variant="metadata" color="text.secondary">对话自动保存；方案草稿仅保存在当前浏览器。</Typography>
          </Box>
        </Box>
        <StepStepper step={stepIndex} finished={Boolean(activeJobId) && activeJobTerminal} />
      </Box>

      <Box sx={{ display: 'flex', minHeight: 0, flexDirection: 'column' }}>
        <Box
          ref={scrollRef}
          sx={{ minWidth: 0, gridTemplateColumns: 'minmax(0, 1fr)', display: 'grid', minHeight: 320, flex: 1, gap: 2.5, overflowY: { xs: 'visible', lg: composerMode === 'running' ? 'auto' : 'visible' }, maxHeight: { xs: 'none', lg: composerMode === 'running' ? '70vh' : 'none' }, px: { xs: 2.5, sm: 2.5 }, py: 2.5 }}
          aria-live="polite"
        >
          {hydrating ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, typography: 'body2', color: 'text.secondary' }}>
              <CircularProgress size={16} thickness={5} sx={{ color: 'primary.main' }} aria-hidden />
              正在恢复对话…
            </Box>
          ) : (
            <>
              {visibleMessages.map((message) => (
                <Box key={message.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexDirection: message.role === 'user' ? 'row-reverse' : 'row' }}>
                  <Box component="span" sx={{ mt: 0.5, display: 'grid', width: 28, height: 28, flexShrink: 0, placeItems: 'center', borderRadius: 1, bgcolor: message.role === 'assistant' ? 'action.selected' : 'action.hover', color: message.role === 'assistant' ? 'primary.main' : 'text.secondary' }}>
                    {message.role === 'assistant' ? <Bot size={14} /> : <UserRound size={14} />}
                  </Box>
                  <Box sx={{ minWidth: 0, maxWidth: '86%', flex: message.role === 'user' ? '0 1 auto' : 1, textAlign: message.role === 'user' ? 'right' : 'left' }}>
                    <Typography component="span" variant="metadata" sx={{ mb: 0.5, display: 'block', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: message.role === 'assistant' ? 'primary.main' : 'text.secondary' }}>
                      {message.role === 'assistant' ? 'AI 调研助手' : '你'}
                    </Typography>
                    {message.role === 'assistant' && message.intent ? (
                      message.content ? (
                        <Box sx={{ mt: 0.5, typography: 'reading', textAlign: 'left', overflowWrap: 'anywhere' }}>
                          <MarkdownContent content={stripResearchCitationMarkers(message.content)} compact />
                        </Box>
                      ) : (
                        <CircularProgress size={14} sx={{ mt: 0.5 }} aria-label="正在生成回答" />
                      )
                    ) : (
                      <Typography component="p" variant="reading" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                        {message.content}
                      </Typography>
                    )}
                  </Box>
                </Box>
              ))}

              {phase === 'understand' && messages.length === 1 ? (
                <Box sx={{ ml: 5, minWidth: 0, pt: 0.5 }}>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                    {EXAMPLE_PROMPTS.map((example) => (
                      <Button
                        key={example}
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => processUserMessage(example)}
                        sx={{ minHeight: 44, borderRadius: 999, borderColor: 'divider', bgcolor: 'background.paper', px: 1.5, py: 1, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere', typography: 'metadata', color: 'text.secondary', transition: (theme) => theme.transitions.create(['background-color', 'border-color', 'color']), '&:hover': { borderColor: 'primary.main', bgcolor: 'action.selected', color: 'text.primary' } }}
                      >
                        {example}
                      </Button>
                    ))}
                  </Box>
                </Box>
              ) : null}

              {phase !== 'understand' && !activeJobId ? (
                <Box sx={{ ml: 5, minWidth: 0 }}>
                  <AiResearchBrief
                    initialBrief={restoredBrief}
                    question={topic}
                    context={context}
                    topicHint={topicIdQuery ?? undefined}
                    startAction={(
                      <Button
                        type="button"
                        size="sm"
                        aria-label="开始调研"
                        onClick={() => void submit()}
                        disabled={submitting || conversationCreating || hydrating || submissionUncertain || scopeIncomplete || sourceSelectionIncomplete || brief?.contextSelectionIncomplete}
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
                      if (value && restoredBrief?.brief?.question !== topic.trim()) setBrief(null);
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
                  />
                  <InlineAiResearchStatus jobId={activeJobId} onRestart={restartWithSameConfig} />
                </Box>
              ) : null}
            </>
          )}
        </Box>

        {draftStorageError ? <Typography role="status" sx={{ mx: 2.5, mb: 1, typography: 'metadata' }}>此浏览器无法保存方案草稿，刷新后设置可能丢失。</Typography> : null}
        {error ? (
          <Box role="alert" sx={{ mx: 2.5, mb: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, border: 1, borderColor: 'error.main', borderRadius: 1, bgcolor: 'var(--dr-color-danger-container)', px: 1.5, py: 1, typography: 'body2', color: 'error.main' }}>
            <Box component="span" sx={{ flex: 1 }}>{error}</Box>
            {errorKind === 'submit' ? <>
              <Link component={NextLink} href="/ai-research?history=1">先查看任务历史，确认是否已启动</Link>
              <Button type="button" variant="outline" size="xs" onClick={() => { void allowRetryAfterHistory(); }}>已核对历史，允许重新提交</Button>
            </> : null}
            {loginRequired ? (
              <Link component={NextLink} href="/signin?callbackUrl=%2Fai-research" underline="always" sx={{ typography: 'metadata', fontWeight: 500, textUnderlineOffset: 2 }}>
                登录后继续
              </Link>
            ) : null}
          </Box>
        ) : null}

        {showInlineFollowUp ? (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, borderTop: 1, borderColor: 'divider', px: 2, py: 1.25 }}>
            <Typography component="span" variant="metadata" color="text.secondary">追问方式</Typography>
            {FOLLOW_UP_SHORTCUTS.map((item) => (
              <Button
                key={item.intent}
                type="button"
                size="xs"
                variant={followUpIntent === item.intent ? 'secondary' : 'outline'}
                aria-pressed={followUpIntent === item.intent}
                onClick={() => setFollowUpIntent(item.intent)}
              >
                {item.label}
              </Button>
            ))}
          </Box>
        ) : null}
        {followUpError ? (
          <Typography component="p" role="alert" sx={{ borderTop: 1, borderColor: 'divider', px: 2, py: 1, typography: 'metadata', color: 'error.main' }}>
            {followUpError}
          </Typography>
        ) : null}
        <Box component="form" data-ai-research-form onSubmit={handleMessageSubmit} sx={{ borderTop: 1, borderColor: 'divider', bgcolor: 'background.paper', p: 2 }}>
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper', transition: 'border-color 120ms ease-out, box-shadow 120ms ease-out', '&:focus-within': { borderColor: 'primary.main', boxShadow: (theme) => `0 0 0 2px ${theme.palette.primary.main}22` } }}>
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={showInlineFollowUp
                ? '继续追问这份研究，例如：这个结论的关键前提是什么？'
                : composerMode === 'running'
                ? '任务运行中，进度和结果会持续显示在这里'
                : composerMode === 'restart'
                ? '这次调研没有生成可追问的结果；请先点上方“重新调研”恢复配置'
                : phase === 'understand'
                  ? '例如：我们是否应该采用 GraphRAG？'
                  : phase === 'refine'
                    ? '补充决策背景，或回复“跳过”'
                    : '继续补充调研要求，或输入“开始调研”'}
              rows={3}
              maxLength={20_000}
              aria-label="AI 调研对话输入"
              disabled={submitting || conversationCreating || hydrating || composerMode === 'running' || composerMode === 'restart'}
              sx={{ '& .MuiOutlinedInput-root': { minHeight: 92, bgcolor: 'transparent', boxShadow: 'none', '& fieldset': { border: 0 } }, '& textarea': { resize: 'none' } }}
            />
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5, px: 1.5, pb: 1.5 }}>
              <Typography component="span" variant="metadata" color="text.secondary">
                {showInlineFollowUp
                  ? (followUpSending ? '正在基于已保存资料回答…' : '回答基于上方报告和已保存资料，并自动保存到当前对话。')
                  : composerMode === 'running'
                    ? '任务完成后可在这里继续追问'
                    : composerMode === 'restart'
                      ? '恢复原配置后可以直接修改并重新开始'
                    : `⌘/Ctrl + Enter 发送 · ${input.length}/20000`}
              </Typography>
              <Button type="submit" size="sm" disabled={!input.trim() || submitting || conversationCreating || hydrating || composerMode === 'running' || composerMode === 'restart' || followUpSending} aria-label="发送消息（AI 调研）">
                {followUpSending ? <CircularProgress size={14} thickness={5} aria-hidden /> : <Send size={14} />}
                {followUpSending ? '回答中…' : '发送'}
              </Button>
            </Box>
          </Box>
        </Box>
      </Box>
    </Paper>
  );
}

