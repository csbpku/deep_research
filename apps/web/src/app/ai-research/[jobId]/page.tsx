'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Lightbulb,
  Library,
  ListChecks,
  PenLine,
  Radar,
  RefreshCw,
  RotateCw,
  XCircle,
} from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import {
  stepIndex as stepIndexShared,
  type DeepResearchProgress,
} from '@/lib/ai-progress';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { retryOnceAi } from '@/lib/errors/friendly';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { PageHeader } from '@/components/domain/PageHeader';
import { AiResearchButton as Button, AiResearchTextarea as Textarea } from '@/components/ai-research/AiResearchMaterial';
import { AppDialog } from '@/components/material/AppDialog';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import MaterialLink from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { space } from '@deep-research/design-system';
import { cleanEvidenceSnippet } from '@/lib/research-report';
import {
  claimDisplayStatus,
  claimIsFactual,
  claimIsCitationRelationship,
  countClaimDisplayStatuses,
  reviewDisplayLabel,
  reviewDisplayStatus,
  claimJudgmentLabel,
  claimJudgmentStatus,
  type AiReviewPhase,
} from '@/lib/ai-review-ui';
import {
  decisionResolvesClaim,
  getReviewPublicationGate,
  reviewCoverageStatus,
  claimEvidenceStatus,
  reviewClaimLocation,
  reviewClaimId,
  reviewClaimNextAction,
  claimIsResearchProcessObservation,
  type ReviewDecisionRecord,
  type ReviewPublicationGate,
} from '@/lib/research-review-decisions';
import { ResearchOutputViews } from '@/components/ai-research/ResearchOutputViews';
import { KnowledgeCardComposer } from '@/components/KnowledgeCardComposer';
import { ResearchChatPanel } from '@/components/ai-research/ResearchChatPanel';
import { AiResearchWorkspaceSidebar } from '@/components/ai-research/AiResearchWorkspaceSidebar';
import { DeepResearchProgressCard } from '@/components/ai-research/DeepResearchProgressCard';
import type { AiResearchConversationDetail } from '@/lib/ai-research-chat';
import {
  summarizeResearchSufficiencyGaps,
  type ResearchSufficiency,
} from '@/lib/research-sufficiency';
import { classifySourceProvenance } from '@/lib/source-provenance';
import { externalContentLabel, hasExternalInstructionSignal } from '@/lib/external-content-safety';
import type { ResearchBrief, ResearchScope } from '@deep-research/shared/schemas';

const textSx = {
  caption: { fontSize: 'var(--dr-type-caption)', lineHeight: 'var(--dr-line-height-body)' },
  label: { fontSize: 'var(--dr-type-label)', lineHeight: 'var(--dr-line-height-body)' },
  body: { fontSize: 'var(--dr-type-body)', lineHeight: 'var(--dr-line-height-body)' },
  titleSmall: { fontSize: 'var(--dr-type-title-small)', lineHeight: 'var(--dr-line-height-heading)', fontWeight: 'var(--dr-weight-semibold)' },
  titleCompact: { fontSize: 'var(--dr-type-title-compact)', lineHeight: 'var(--dr-line-height-heading)', fontWeight: 'var(--dr-weight-semibold)' },
  titleMedium: { fontSize: 'var(--dr-type-title-medium)', lineHeight: 'var(--dr-line-height-heading)', fontWeight: 'var(--dr-weight-semibold)' },
  medium: { fontWeight: 'var(--dr-weight-medium)' },
  semibold: { fontWeight: 'var(--dr-weight-semibold)' },
  muted: { color: 'text.secondary' },
  primary: { color: 'primary.main' },
  warning: { color: 'warning.main' },
  danger: { color: 'error.main' },
  success: { color: 'success.main' },
} as const;

const surfaceSx = {
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: 'var(--dr-radius-small)',
  bgcolor: 'background.paper',
} as const;

const statusToneSx = {
  warning: { borderColor: 'warning.main', bgcolor: 'var(--dr-color-warning-container)', color: 'warning.main' },
  danger: { borderColor: 'error.main', bgcolor: 'var(--dr-color-danger-container)', color: 'error.main' },
  success: { borderColor: 'success.main', bgcolor: 'var(--dr-color-success-container)', color: 'success.main' },
} as const;

const pillSx = {
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: 'var(--dr-radius-pill)',
  px: space.sm,
  py: space.xs,
  ...textSx.caption,
  ...textSx.medium,
} as const;

interface AiJobStatus {
  jobId: string;
  status: string;
  finalStatus: string | null;
  currentStep: string | null;
  sourcesCount: number;
  savedSourcesCount: number;
  capturedSourcesCount?: number;
  userSourceRefsCount: number;
  autoSourceRefsCount: number;
  topic: string | null;
  partialSourcesCount: number;
  failedSourcesCount: number;
  errorStage: string | null;
  tokenInputTotal: number;
  tokenOutputTotal: number;
  costCents: number;
  draftResearchId: string | null;
  reportType: string | null;
  reportLength: 'brief' | 'standard' | 'deep';
  deliverableStatus?: 'report' | 'evidence_only' | 'none';
  researchProgress: DeepResearchProgress | null;
  researchSufficiency: ResearchSufficiency | null;
  sourcePolicy: 'prefer_user_sources' | 'only_user_sources';
  brief: ResearchBrief | null;
  sourceRefs: Array<{ type: string; value: string; required?: boolean; resolvedTitle?: string; resolvedSnippet?: string }>;
  outputText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: Record<string, unknown> | null;
  startedAt: string | null;
  createdAt: string | null;
  completedAt: string | null;
  review: ReviewDetails | null;
  reviewRun: ReviewRunDetails | null;
  conversation: Array<{ id: string; role: 'user' | 'assistant'; content: string }>;
  sources: Array<{
    id: string;
    title: string;
    snippet: string | null;
    score: number | null;
    href: string | null;
    type: string;
    stepCaptured: string;
    capturedAt: string;
    sourceRef?: unknown;
  }>;
  artifact: {
    type: 'markdown' | 'slides' | 'table' | 'chart';
    title: string;
    version: number;
    mimeType: string;
    content: string | null;
    rawContent: string | null;
    payload: unknown | null;
    sourceRefs: Array<{ type: string; value: string; title?: string | null }>;
    sourceHash: string | null;
    draftResearchId: string | null;
  } | null;
}

function researchOutputLabel(reportType: string | null | undefined): string {
  if (reportType === 'slides') return 'Slides 提纲';
  if (reportType === 'web_brief') return '网页简报';
  if (reportType === 'summary_brief') return '快速判断';
  return '研究稿';
}

function publicationGateStatus(
  status: ReviewPublicationGate['status'],
  fallbackOutcome?: string | null,
): 'passed' | 'needs_action' | 'blocked' | 'review_unavailable' {
  switch (status) {
    case 'clear':
    case 'publish_with_disclosure':
      return 'passed';
    case 'blocked':
      return 'blocked';
    case 'unavailable':
      return 'review_unavailable';
    case 'needs_action':
    case 'coverage_insufficient':
    case 'research_insufficient':
      return 'needs_action';
    default:
      return fallbackOutcome === 'blocked' ? 'blocked' : 'needs_action';
  }
}

/**
 * Reader-facing projection of the quality gate.
 *
 * The underlying review has a richer state machine, but a reader only needs
 * one answer at this level: can I use this result, do I need to confirm
 * something, or is the check unavailable? Keep the workflow vocabulary in
 * the details disclosure instead of making users learn it up front.
 */
function ReviewGateChip({
  gate,
  executionStatus,
  researchSufficiency,
}: {
  gate: ReviewPublicationGate;
  executionStatus: string | null;
  researchSufficiency: ResearchSufficiency | null;
}) {
  const running = executionStatus === 'queued' || executionStatus === 'reviewing';
  const researchCoverageUnassessed = gate.status === 'clear'
    && (researchSufficiency?.status ?? 'not_assessed') === 'not_assessed';
  const label = running
    ? '结果整理中'
    : gate.status === 'clear'
      ? researchCoverageUnassessed ? '可以参考 · 资料范围未确认' : '可以直接参考'
      : gate.status === 'publish_with_disclosure'
        ? '需要确认'
            : gate.status === 'blocked'
          ? '需要修改'
            : gate.status === 'unavailable'
            ? '暂时无法确认'
              : gate.status === 'coverage_insufficient'
              ? '资料范围有缺口'
              : gate.status === 'research_insufficient'
                ? '资料范围有缺口'
                : '需要确认';
  const tone = running || researchCoverageUnassessed || gate.status === 'unavailable' || gate.status === 'coverage_insufficient' || gate.status === 'research_insufficient'
    ? statusToneSx.warning
    : gate.status === 'blocked'
      ? statusToneSx.danger
      : gate.status === 'clear'
        ? statusToneSx.success
        : statusToneSx.warning;
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex', alignItems: 'center',
        border: '1px solid', borderRadius: 'var(--dr-radius-pill)',
        px: space.sm, py: space.xs, ...textSx.caption, ...textSx.medium, ...tone,
      }}
      aria-label={`结果状态：${label}`}
    >
      {label}
    </Box>
  );
}

interface ReviewClaim {
  claim_id?: string;
  claim?: string;
  claim_type?: 'external_fact' | 'research_process' | 'interpretation' | 'citation_relationship' | string;
  risk?: string;
  verdict?: string;
  judgment_status?: 'settled' | 'not_judged' | 'execution_failed' | 'disputed' | string;
  execution_error_code?: string | null;
  reason?: string | null;
  correction?: string | null;
  location?: [number, number] | { start: number; end: number } | null;
  nextAction?: 'challenge_support' | 'reverify_current_sources' | 'find_more_evidence' | 'edit_claim' | 'none';
  evidence?: {
    source_url?: string | null;
    excerpt?: string | null;
    observed_at?: string | null;
    resolver?: string | null;
    source_type?: string | null;
    published_at?: string | null;
    evidence_strength?: string | null;
    counterexamples?: string[];
  } | null;
}

interface ReviewDetails {
  phase?: AiReviewPhase;
  status?: string;
  error?: string | null;
  error_code?: string | null;
  attempts?: number;
  corrected_count?: number;
  unverified_count?: number;
  contradicted_count?: number;
  evidence_gap_count?: number;
  evidence_gap_instruction_count?: number;
  factual_claim_count?: number;
  citation_count?: number;
  citation_pending_count?: number;
  coverage_status?: 'complete' | 'insufficient' | 'not_applicable' | string;
  review_outcome?: 'clear' | 'attention' | 'blocked' | 'unavailable' | string;
  claims?: ReviewClaim[];
}

interface ReviewRunDetails {
  id: string;
  isCurrentRevision?: boolean;
  revisionHash: string;
  sourceSnapshotHash: string;
  policyVersion: string;
  executionStatus: 'queued' | 'reviewing' | 'completed' | 'unavailable' | 'stale' | string;
  outcome?: 'clear' | 'attention' | 'blocked' | 'insufficient' | 'unavailable' | 'stale' | string | null;
  attempt: number;
  startedAt?: string | null;
  leaseExpiresAt?: string | null;
  heartbeatAt?: string | null;
  completedAt?: string | null;
  summary?: Record<string, unknown> | null;
  claims?: ReviewClaim[];
  decisions?: ReviewDecisionRecord[];
  publicationGate?: ReviewPublicationGate | null;
  details?: Record<string, unknown> | null;
  triggeredBy: string;
  createdAt: string;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'partial']);
const STEPS = [
  { key: 'plan', label: '规划研究问题', desc: '拆分背景、约束和验证方向', icon: ListChecks },
  { key: 'search', label: '检索与抓取', desc: '先处理已选资料，再按检索设置补充公开网页', icon: Radar },
  { key: 'compress', label: '压缩证据', desc: '合并相似结论并保留来源链路', icon: FileText },
  { key: 'analyze', label: '分析与对比', desc: '形成可执行的取舍和风险判断', icon: Lightbulb },
  { key: 'write', label: '写作草稿', desc: '生成可编辑的团队私有草稿', icon: PenLine },
] as const;

type ProcessStep = (typeof STEPS)[number];
type TimelineStepData = Pick<ProcessStep, 'key' | 'icon'> & { label: string; desc: string };

type StepState = 'done' | 'current' | 'attention' | 'error' | 'waiting';

/**
 * AI 调研任务状态页。
 *
 * 验收 4：每 5s 轮询 /api/ai-research/[jobId]；终态自动停止。
 */
export default function AiJobStatusPage() {
  const params = useParams<{ jobId: string }>();
  const queryClient = useQueryClient();
  const q = useQuery<AiJobStatus>({
    queryKey: ['ai-job', params.jobId],
    queryFn: async () => {
      const r = await fetch(`/api/ai-research/${params.jobId}`, { cache: 'no-store' });
      if (!r.ok) throw await toApiHttpError(r, '加载失败');
      return (await r.json()) as AiJobStatus;
    },
    retry: retryOnceAi,
    refetchInterval: (data) => {
      // A transient BFF/engine timeout must not turn a long-running research
      // task into a dead page. Keep polling when a last-known-good snapshot
      // exists; an initial failure also gets a bounded retry cadence.
      if (data.state.status === 'error') return data.state.data ? 10_000 : 5_000;
      const s = data?.state.data;
      if (!s) return 5_000;
      // 研究已完成后，独立事实审核仍需短暂轮询；审核终态才停止。
      if (s.finalStatus && TERMINAL.has(s.finalStatus)) {
        const reviewStatus = s.reviewRun?.executionStatus ?? s.review?.status ?? s.review?.phase;
        return reviewStatus === 'queued' || reviewStatus === 'reviewing' ? 3_000 : false;
      }
      // queued / running 持续 5s 轮询
      return 5_000;
    },
    refetchIntervalInBackground: false,
  });

  // SSE can report the adapter's terminal state a moment before the runner
  // commits the generated draft. React Query then stops its interval polling
  // with an incomplete terminal payload. Re-read once at the terminal edge
  // (and once more if the draft is still catching up) so a completed task
  // never presents a result page without its report.
  const terminalRefreshKey = `${params.jobId}:${q.data?.finalStatus ?? ''}`;
  const terminalRefreshRef = useRef<string | null>(null);
  useEffect(() => {
    const data = q.data;
    if (!data?.finalStatus || !TERMINAL.has(data.finalStatus)) return;
    if (data.finalStatus === 'succeeded' && data.artifact?.content) return;
    if (terminalRefreshRef.current === terminalRefreshKey) return;
    terminalRefreshRef.current = terminalRefreshKey;

    let cancelled = false;
    let retryTimer: number | undefined;
    let attempts = 0;
    const refreshTerminalPayload = async () => {
      attempts += 1;
      const result = await q.refetch();
      if (
        cancelled
        || attempts >= 2
        || data.finalStatus !== 'succeeded'
        || result.data?.artifact?.content
      ) return;
      retryTimer = window.setTimeout(() => void refreshTerminalPayload(), 750);
    };
    void refreshTerminalPayload();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [q.data, q.refetch, terminalRefreshKey]);

  // 轮询是可靠兜底；SSE 让详情页在步骤和来源变化时立即更新。
  useEffect(() => {
    const status = q.data?.finalStatus ?? q.data?.status;
    if (!q.data || (status && TERMINAL.has(status))) return;
    const controller = new AbortController();
    let cancelled = false;

    async function consumeProgress() {
      try {
        const response = await fetch(`/api/ai-research/${params.jobId}/stream`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            // SSE 帧可能含 event:/data:/id:/retry: 多行;这里只关心 event 名 + data 载荷,
            // event 行缺失时默认 'progress'(与上游约定一致)。
            const lines = frame.split('\n');
            let eventName = 'progress';
            const dataLine = lines.find((item) => item.startsWith('data: '));
            const eventLine = lines.find((item) => item.startsWith('event: '));
            if (eventLine) eventName = eventLine.slice(7).trim();
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(6)) as Partial<AiJobStatus>;
              queryClient.setQueryData<AiJobStatus>(
                ['ai-job', params.jobId],
                (old) => (old ? { ...old, ...payload, lastEvent: eventName } : old),
              );
            } catch (err) {
              // 单帧解析失败不影响后续帧 —— 仅记一条 warn,保留兜底轮询
              if (typeof console !== 'undefined') {
                console.warn('[ai-research SSE] failed to parse frame', { eventName, err });
              }
            }
          }
        }
      } catch {
        // 保留轮询作为 SSE 不可用时的兜底路径。
      }
    }

    void consumeProgress();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [params.jobId, q.data?.finalStatus, q.data?.status, queryClient]);

  return (
    <Box className="material-surface" sx={{ width: '100%', maxWidth: 'var(--dr-width-shell)', mx: 'auto' }}>
      <PageHeader
        variant="workbench"
        title={
          <span aria-live="polite" aria-atomic="true">
            {q.isError && !q.data ? '无法加载调研' : q.data?.finalStatus && TERMINAL.has(q.data.finalStatus) ? '调研结果' : '调研进行中'}
          </span>
        }
        description={
          q.data
            ? `${researchOutputLabel(q.data.reportType)} · ${q.data.topic ?? '本次调研'}`
            : '正在读取调研任务状态…'
        }
        actions={
          <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.sm }}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void q.refetch()}
              aria-label="刷新调研状态"
            >
              <RefreshCw />
              刷新
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/ai-research?history=1">查看调研历史</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/ai-research">
                <ArrowLeft />
                新建 AI 调研
              </Link>
            </Button>
          </Box>
        }
      />

      <Box sx={{ mt: space.xl, display: 'grid', alignItems: 'start', gap: 3, gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: '280px minmax(0, 1fr)' } }}>
        <Box sx={{ order: { xs: 1, lg: 2 }, minWidth: 0 }}>
          {q.isLoading && !q.data ? (
            <JobStatusSkeleton />
          ) : q.isError && !q.data ? (
            <EmptyState
              title="加载失败"
              description={friendlyMessage(q.error, '请稍后重试')}
              action={
                <Button type="button" size="sm" onClick={() => void q.refetch()}>
                  重试
                </Button>
              }
            />
          ) : q.data ? (
            <StatusBody s={q.data} />
          ) : null}
          {q.isError && q.data ? (
            <Box
              component="div"
              role="status"
              aria-live="polite"
              sx={{ ...statusToneSx.warning, border: '1px solid', borderRadius: 'var(--dr-radius-small)', ...textSx.caption, mt: space.md, px: space.md, py: space.sm }}
            >
              状态同步暂时失败，已保留上次成功状态；任务可能仍在后台运行，系统会继续重试。
            </Box>
          ) : null}
        </Box>
        <Box sx={{ order: { xs: 2, lg: 1 }, minWidth: 0 }}>
          {/* 结果页的主任务是读懂本轮研究；完整任务历史在新建工作台中统一管理。 */}
          <AiResearchWorkspaceSidebar showTaskHistory={false} showRecentArtifacts={false} />
        </Box>
      </Box>
    </Box>
  );
}

/** 步骤形加载骨架 —— 与实际页面布局对齐,避免单一大方块。 */
function JobStatusSkeleton() {
  return (
    <Paper variant="outlined" sx={{ ...surfaceSx, borderRadius: 'var(--dr-radius-medium)', p: 2 }}>
      <Box component="div" sx={{ mb: space.md, display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.md }}>
        <Box component="div" sx={{ minWidth: 0, display: 'grid', gap: space.sm }}>
          <Skeleton sx={{ height: 12, width: 64 }} />
          <Skeleton sx={{ height: 20, width: 160 }} />
          <Skeleton sx={{ height: 12, width: 224 }} />
        </Box>
        <Box component="div" sx={{ flexShrink: 0, display: 'grid', gap: space.xs, textAlign: 'right' }}>
          <Skeleton sx={{ ml: 'auto', height: 32, width: 80 }} />
          <Skeleton sx={{ ml: 'auto', height: 12, width: 64 }} />
        </Box>
      </Box>
      <Skeleton sx={{ height: 8, width: '100%' }} />
      <Box component="div" sx={{ mt: space.lg, display: 'grid', gap: space.md }}>
        <Skeleton sx={{ height: 12, width: 128 }} />
        <Box component="div" sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))', lg: 'repeat(6, minmax(0, 1fr))' }, gap: space.sm }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} sx={{ height: 80, width: '100%', borderRadius: 'var(--dr-radius-medium)' }} />
          ))}
        </Box>
        <Skeleton sx={{ height: 32, width: '100%' }} />
      </Box>
    </Paper>
  );
}

function StatusBody({ s }: { s: AiJobStatus }) {
  const queryClient = useQueryClient();
  const finalStatus = s.finalStatus;
  const isTerminal = !!(finalStatus && TERMINAL.has(finalStatus));
  const evidenceOnly = s.deliverableStatus === 'evidence_only';
  const hasReaderReport = Boolean(s.artifact?.content ?? s.outputText) && !evidenceOnly;
  const hasEvidenceSnapshot = evidenceOnly && Boolean(s.artifact?.content);
  // The durable research ledger is authoritative after claim-scoped evidence
  // tasks. Runtime progress is only a historical snapshot and may still say
  // "1 captured" after the ledger has grown to 12 sources.
  const capturedSources = Math.max(
    s.capturedSourcesCount ?? 0,
    s.partialSourcesCount ?? 0,
    s.researchProgress?.sourcesCaptured ?? 0,
  );
  // Evidence-only / legacy jobs may not have a sufficiency snapshot, but the
  // source list still needs to communicate independent evidence clusters.
  // Derive the fallback from normalized provenance keys instead of showing a
  // misleading "独立域名 0" beside visible captured sources.
  const visibleIndependentSourceCount = new Set(
    s.sources
      .filter((source) => Boolean(source.href))
      .map((source) => classifySourceProvenance({ href: source.href, type: source.type, title: source.title }).independentKey),
  ).size;
  const independentSourceCount = s.researchSufficiency?.independentSourceCount ?? visibleIndependentSourceCount;

  // 实时计时 —— 终态停止;长任务(>5min)降级到 30s tick,避免低端机浪费
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (isTerminal) return;
    const startedAt = Date.now();
    let intervalId: ReturnType<typeof setInterval> | undefined;
    function schedule() {
      const ageMs = Date.now() - startedAt;
      intervalId = setInterval(() => setNow(Date.now()), ageMs > 5 * 60_000 ? 30_000 : 1000);
    }
    schedule();
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [isTerminal]);

  const elapsed = formatElapsed(s, now);
  const statusLabel = jobStatusLabel(s);
  const isBrief = s.reportType === 'summary_brief';
  const outputLabel = researchOutputLabel(s.reportType);
  // A brief can finish as a model-only answer when retrieval returns no
  // usable page. That is an execution result, not an evidence-backed
  // research result; keep the distinction visible at the point of reading.
  const evidenceFreeBrief = isBrief
    && isTerminal
    && s.sources.length === 0
    && s.sourcesCount === 0
    && s.savedSourcesCount === 0
    && capturedSources === 0;
  // Research execution and fact review are separate lifecycles. Prefer the
  // version-scoped run whenever the legacy mirror and the durable run differ.
  const reviewExecutionStatus = s.reviewRun?.executionStatus
    ?? s.review?.status
    ?? s.review?.phase
    ?? null;
  const reviewInProgress = reviewExecutionStatus === 'queued' || reviewExecutionStatus === 'reviewing';
  const reviewCompleted = s.reviewRun?.executionStatus === 'completed'
    || s.review?.phase === 'completed'
    || (!!s.review?.status && s.review.status !== 'reviewing');
  const researchSufficiency = s.researchSufficiency;
  const publicationGate = s.reviewRun?.publicationGate ?? getReviewPublicationGate({
    executionStatus: s.reviewRun?.executionStatus,
    outcome: s.reviewRun?.outcome,
    coverageStatus: reviewCoverageStatus(s.reviewRun?.summary),
    researchSufficiencyStatus: researchSufficiency?.status,
    claims: s.reviewRun?.claims ?? s.review?.claims,
    decisions: s.reviewRun?.decisions,
  });
  // The raw worker outcome is only an observation about the original run.
  // The actionable state is the current publication gate, which also reflects
  // decisions made after the worker finished and excludes process observations
  // from the human fact-review queue.
  const reviewStatus = s.reviewRun?.executionStatus === 'completed'
    ? publicationGateStatus(publicationGate.status, s.reviewRun.outcome)
    : reviewExecutionStatus ?? reviewDisplayStatus(s.review);
  const reportNeedsReview = finalStatus === 'succeeded'
    && (
      ['queued', 'reviewing', 'blocked', 'review_unavailable', 'unavailable', 'stale'].includes(reviewStatus)
      || publicationGate.status === 'needs_action'
      || publicationGate.status === 'coverage_insufficient'
      || publicationGate.status === 'research_insufficient'
      || researchSufficiency?.status === 'insufficient'
    );
  const hasReviewClaims = Boolean(s.reviewRun?.claims?.length || s.review?.claims?.length);
  // The background check should not become a second progress workflow. Keep
  // its compact outcome visible only after research has finished; while it is
  // running, the result header already says that the result is being整理.
  const showResultState = isTerminal
    && !reviewInProgress
    && (finalStatus === 'succeeded' && (reportNeedsReview || reviewStatus !== 'passed' || hasReviewClaims));
  // Research execution and fact review are different lifecycles. The main
  // progress indicator answers "did the research run finish?"; the review
  // gate is shown separately so one unresolved claim cannot make a completed
  // research job look like a failed job.
  // A completed report is an outcome, not an ongoing progress task. The
  // status badge and reader-facing gate already answer what the user needs;
  // keeping a second "100%" meter here adds noise and makes the review gate
  // look like another workflow. Preserve progress only while work is running,
  // and show a compact outcome for partial/failed/no-evidence terminal states.
  const showTerminalOutcome = isTerminal && (evidenceFreeBrief || finalStatus !== 'succeeded');
  const terminalProgressLabel = evidenceFreeBrief
    ? '无证据'
    : finalStatus === 'succeeded'
    ? '已完成'
    : finalStatus === 'partial'
      ? evidenceOnly ? '未形成报告' : '阶段性研究稿'
    : finalStatus === 'failed'
      ? '未完成'
      : finalStatus === 'cancelled'
        ? '已取消'
        : null;
  const terminalProgressCaption = evidenceFreeBrief
    ? '仅模型摘录'
    : finalStatus === 'succeeded'
    ? '研究执行已完成 · 质量状态见下方'
    : finalStatus === 'partial'
      ? evidenceOnly ? '资料已保留' : '研究未完成'
    : finalStatus === 'failed'
      ? '任务失败'
      : finalStatus === 'cancelled'
        ? '任务已撤回'
        : null;
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    function refreshReport(event: Event) {
      const detail = (event as CustomEvent<{ reportId?: string }>).detail;
      if (detail?.reportId === s.draftResearchId) void queryClient.invalidateQueries({ queryKey: ['ai-job', s.jobId] });
    }
    window.addEventListener('ai-research-report-updated', refreshReport);
    return () => window.removeEventListener('ai-research-report-updated', refreshReport);
  }, [queryClient, s.draftResearchId, s.jobId]);

  async function cancelJob(): Promise<boolean> {
    if (cancelling || isTerminal) return false;
    setCancelling(true);
    setCancelError(null);
    try {
      const response = await fetch(`/api/ai-research/${encodeURIComponent(s.jobId)}/cancel`, { method: 'POST' });
      if (!response.ok) throw await toApiHttpError(response, '取消调研失败');
      await queryClient.invalidateQueries({ queryKey: ['ai-job', s.jobId] });
      return true;
    } catch (error) {
      setCancelError(friendlyMessage(error, '取消调研失败，请稍后重试。'));
      return false;
    } finally {
      setCancelling(false);
    }
  }

  // 审核阶段(reviewing / completed)优先覆盖 currentStep,避免步骤计数仍指 write。
  const effectiveStep =
    reviewInProgress || reviewCompleted
      ? 'review'
      : (s.currentStep ?? s.errorStage ?? null);
  const activeIdx = stepIndexShared(effectiveStep);

  const conversationQuery = useQuery<AiResearchConversationDetail | null>({
    queryKey: ['ai-research-conversation', s.jobId],
    queryFn: async () => {
      const r = await fetch(`/api/ai-research/conversations/by-job/${encodeURIComponent(s.jobId)}`, { cache: 'no-store' });
      if (r.status === 404) return null;
      if (!r.ok) throw await toApiHttpError(r, '加载对话失败');
      return await r.json() as AiResearchConversationDetail;
    },
    retry: retryOnceAi,
    refetchOnWindowFocus: false,
  });

  // 旧任务没有持久化会话时，用 job 里的 conversation 快照补建一条，
  // 保证完成后仍然可以继续追问。
  const [conversationEnsureTried, setConversationEnsureTried] = useState(false);
  useEffect(() => {
    if (conversationQuery.data !== null || conversationEnsureTried) return;
    setConversationEnsureTried(true);
    void fetch('/api/ai-research/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: s.topic ?? 'AI 调研',
        jobId: s.jobId,
        messages: s.conversation.map(({ role, content }) => ({ role, content })),
      }),
    })
      .then(async (response) => {
        if (response.ok) await conversationQuery.refetch();
      })
      .catch(() => undefined);
  }, [conversationQuery.data, conversationEnsureTried, s.conversation, s.jobId, s.topic]);

  return (
    <Paper component="section" variant="outlined" className="material-surface" sx={{ overflow: 'hidden' }}>
      <Box component="div" sx={{ px: space.xl, py: space.xl, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.lg }}>
          <Box component="div" sx={{ minWidth: 0 }}>
            <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.sm }}>
              <StatusBadge kind="job" value={statusLabel} label={statusLabel} />
              {finalStatus === 'succeeded' && !evidenceFreeBrief ? (
                <ReviewGateChip gate={publicationGate} executionStatus={reviewExecutionStatus} researchSufficiency={researchSufficiency} />
              ) : null}
              <Box component="span" sx={{ display: 'flex', flexWrap: 'wrap', columnGap: space.sm, fontVariantNumeric: 'tabular-nums', ...textSx.caption, ...textSx.muted }} aria-label={`研究耗时 ${elapsed}`}>
                <span>研究耗时 {elapsed}</span>
              </Box>
            </Box>
            <Typography component="h2" variant="h2" sx={{ mt: space.md, letterSpacing: '-0.025em' }}>
              {isTerminal
                ? evidenceOnly ? '资料已保留' : evidenceFreeBrief ? `${outputLabel}已生成，但未找到资料` : finalStatus === 'succeeded' ? reportNeedsReview ? `${outputLabel}已生成` : '研究完成' : '研究已结束'
                : hasReaderReport ? `${outputLabel}已生成` : '正在建立证据链'}
            </Typography>
            <Typography component="p" variant="body2" sx={{ mt: space.xs, ...textSx.muted }} aria-live="polite" aria-atomic="true">
              {evidenceFreeBrief
                ? '本轮没有保存可核对资料；下面的内容只是模型摘录，不能作为已验证的研究结论。'
                : reviewInProgress
                ? `${outputLabel}已整理，正在补充依据；完成后会自动更新。`
                : !isTerminal && hasReaderReport
                  ? `${outputLabel}已经可读；依据还在整理，完成后会自动更新。`
                : reviewCompleted && reviewStatus === 'passed'
                  ? '主要结论都有对应资料；仍可打开来源查看原文。'
                  : reviewCompleted
                      ? `${outputLabel}已生成；下面只列出需要你确认的地方。`
                      : isTerminal && evidenceOnly
                        ? '本轮完成资料检索，但没有形成可交付结论；已保留可核对正文。'
                      : isTerminal && finalStatus === 'partial'
                          ? '任务已结束，已保留阶段性资料；关键结论尚未完成确认。'
                        : isTerminal && finalStatus === 'failed'
                          ? '任务未完成；请查看错误信息和已保留的资料。'
                      : s.reportLength === 'deep' && s.researchProgress?.mode === 'deep'
                      ? deepResearchActivityLabel(s)
                      : `${activeIdx >= 0 ? STEPS[activeIdx].label : '准备研究'} · ${capturedSources} 条可核对正文`}
            </Typography>
          </Box>
          {showTerminalOutcome ? (
            <Box component="div" sx={{ flexShrink: 0, textAlign: 'right' }}>
              <Box component="div" sx={{ ...textSx.titleCompact, ...textSx.muted, fontFamily: 'monospace' }}>{terminalProgressLabel}</Box>
              <Box component="div" sx={{ mt: space.xs, ...textSx.caption, ...textSx.muted }}>
                {terminalProgressCaption}
              </Box>
            </Box>
          ) : null}
        </Box>
        {showTerminalOutcome ? (
          <Typography component="p" sx={{ mt: space.lg, ...textSx.caption, ...textSx.muted }} role="status">
            {terminalProgressLabel} · {terminalProgressCaption}
          </Typography>
        ) : null}
        {s.reportLength === 'deep' ? (
          <DeepResearchProgressCard
            progress={s.researchProgress}
            savedSources={s.savedSourcesCount}
            capturedSources={capturedSources}
            terminalStatus={finalStatus}
            reviewStatus={reviewStatus}
            summaryOnly={!isTerminal}
            gaps={checkpointGaps(s, isTerminal)}
            compact={isTerminal}
          />
        ) : null}
      </Box>

      {/* 完成态首先呈现用户来这里要读懂的结果；过程和来源仍保留在下方供核查。 */}
      {(isTerminal || hasReaderReport) && s.artifact?.content && (hasReaderReport || hasEvidenceSnapshot) ? (
          <Box component="section" sx={{ px: space.xl, py: space.section, borderTop: '1px solid', borderColor: 'divider', bgcolor: 'action.selected' }} aria-label={evidenceOnly ? '本轮资料快照' : !isTerminal ? `${outputLabel}（依据整理中）` : `${outputLabel}结果`}>
          <Box component="div" sx={{ mb: space.xl, pb: space.lg, display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.md, borderBottom: '1px solid', borderColor: 'divider' }}>
            <div>
              <Typography component="p" sx={{ ...textSx.caption, ...textSx.semibold, color: evidenceOnly || finalStatus === 'partial' ? 'warning.main' : 'primary.main', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {evidenceOnly ? '资料摘要' : !isTerminal ? `${outputLabel} · 依据整理中` : finalStatus === 'partial' ? `阶段性${outputLabel}` : '研究产物'}
              </Typography>
              <Typography component="h3" sx={{ mt: space.xs, ...textSx.titleCompact }}>{s.artifact.title}</Typography>
              <Typography component="p" sx={{ mt: space.xs, ...textSx.caption, ...textSx.muted }}>
                {s.sources.length > 0
                ? `${s.sources.length < s.savedSourcesCount ? `已保存 ${s.savedSourcesCount} 条，当前展示最近 ${s.sources.length} 条` : `${s.savedSourcesCount} 条资料`} · ${capturedSources} 条有可核对正文 · 第 ${s.artifact.version} 版 · 可打开来源并核对原文`
                  : s.sourcesCount > 0
                    ? `运行时发现 ${s.sourcesCount} 条候选网页，但没有保存可核对正文 · 第 ${s.artifact.version} 版`
                    : `本轮未保存可核对资料 · 第 ${s.artifact.version} 版`}
              </Typography>
                {!isTerminal && hasReaderReport ? (
                  <Typography component="p" sx={{ mt: space.sm, maxWidth: 672, ...textSx.caption, ...textSx.muted }}>
                    这份研究稿已基于本轮实际抓取的证据生成，可以先阅读；关键结论确认完成后，页面会补充最终状态。
                  </Typography>
                ) : evidenceOnly ? (
                  <Typography component="p" sx={{ mt: space.sm, maxWidth: 672, ...textSx.caption, ...textSx.warning }}>
                    本轮只保存了实际抓取的来源摘录，没有生成可交付的研究结论。请把它当作下一轮研究输入，不要当成已验证报告。
                  </Typography>
                ) : finalStatus === 'partial' ? (
                <Typography component="p" sx={{ mt: space.sm, maxWidth: 672, ...textSx.caption, ...textSx.warning }}>
                  研究稿已在关键结论确认完成前保存。它可以阅读和追问，但关键判断请先核对下方来源，或重新运行以完成确认。
                </Typography>
              ) : null}
            </div>
            {finalStatus === 'succeeded' && !isBrief && s.draftResearchId ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/researches/${s.draftResearchId}/edit`}>
                  <PenLine size={14} />
                  {s.reportType === 'slides' ? '编辑 Slides 提纲' : '编辑研究稿'}
                </Link>
              </Button>
            ) : null}
            {hasEvidenceSnapshot ? (
              <Button asChild variant="outline" size="sm">
                <Link href="#research-chat">
                  基于这批资料追问
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="ghost" size="sm">
              <Link href="/researches">
                <Library size={14} />
                查看研究库
              </Link>
            </Button>
          </Box>
          <Box
            component="div"
            sx={{ mx: 'auto', maxWidth: 'var(--dr-width-content-list)' }}
            data-knowledge-source-message={s.draftResearchId ?? undefined}
          >
            <ResearchOutputViews
              content={s.artifact.content}
              artifactType={evidenceOnly ? 'markdown' : s.artifact.type === 'slides' ? 'slides' : 'markdown'}
              sources={s.sources}
              evidenceOnly={evidenceOnly}
              presentationType={s.reportType === 'web_brief' ? 'web' : 'standard'}
              reviewStatus={s.review?.status}
              showQualityStatus={false}
            />
            {s.draftResearchId ? (
              <KnowledgeCardComposer sourceKind="research_report" messageId={s.draftResearchId} />
            ) : null}
          </Box>
        </Box>
      ) : null}

      {isTerminal && !!s.artifact?.content && (hasReaderReport || hasEvidenceSnapshot) ? (
        <Box component="div" sx={{ px: space.xl, pb: space.xl, borderTop: '1px solid', borderColor: 'divider' }}>
          <ResearchChatPanel
            conversation={conversationQuery.data ?? null}
            canAsk={hasReaderReport || hasEvidenceSnapshot}
            note={evidenceOnly
              ? '当前只有可核对资料快照；追问只会基于这批资料回答，不会把它自动变成研究结论。'
              : finalStatus === 'partial' ? '可基于阶段性研究稿继续追问；如需把它作为正式依据，请先完成关键结论确认。' : '回答会基于上方报告和本次研究上下文。'}
            reportId={s.draftResearchId}
            reportContent={s.artifact?.content ?? null}
          />
        </Box>
      ) : null}

      <Box component="div" sx={{ p: space.xl }}>
        {!isBrief && !evidenceOnly && showResultState ? (
          <Box component="section" id="quality-check" sx={{ mb: space.xl }} aria-label="使用建议">
            <ReviewPanel review={s.review} reviewRun={s.reviewRun} researchSufficiency={researchSufficiency} draftResearchId={s.draftResearchId} />
          </Box>
        ) : null}
        <Box component="details" sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'action.selected' }}>
          <Box component="summary" sx={{ display: 'flex', cursor: 'pointer', listStyle: 'none', alignItems: 'center', justifyContent: 'space-between', gap: space.md, px: space.lg, py: space.md, '&::-webkit-details-marker': { display: 'none' }, ...textSx.label, ...textSx.medium, color: 'text.primary' }}>
            <span>查看研究详情</span>
            <Box component="span" sx={{ ...textSx.caption, ...textSx.muted, fontWeight: 'var(--dr-weight-regular)' }}>
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>研究过程 · 资料 · 证据缺口</Box>
              <Box component="span" sx={{ display: { xs: 'inline', sm: 'none' } }}>过程与资料</Box>
            </Box>
          </Box>
          <Box component="div" sx={{ px: space.lg, pb: space.lg, pt: space.lg, borderTop: '1px solid', borderColor: 'divider' }}>
            <Box component="div" sx={{ mb: space.lg, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <Typography component="p" sx={{ ...textSx.caption, ...textSx.muted }}>按时间顺序记录研究如何得出结论。</Typography>
              </div>
              {!isTerminal ? (
                <Box component="div" sx={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
                  <Button type="button" variant="outline" size="xs" onClick={() => void cancelJob()} disabled={cancelling}>
                    <Box component={XCircle} sx={{ width: 12, height: 12, animation: cancelling ? 'researchPulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' : 'none', '@keyframes researchPulse': { '50%': { opacity: 0.5 } } }} />
                    {cancelling ? '取消中…' : '取消调研'}
                  </Button>
                </Box>
              ) : null}
            </Box>
            {cancelError ? <Typography component="p" role="alert" sx={{ mt: space.sm, ...textSx.caption, ...textSx.danger }}>{cancelError}</Typography> : null}
            <Box component="div" sx={{ position: 'relative', ml: space.xs, pl: space.section, borderLeft: '1px solid', borderColor: 'divider' }}>
              {STEPS.map((step, idx) => {
                const state = stepState(s, idx);
                const displayStep = isBrief && step.key === 'write'
                  ? { ...step, label: '生成摘要', desc: '生成轻量摘要，不创建研究稿' }
                  : step;
                return (
                  <TimelineStep key={step.key} step={displayStep} state={state} count={countForStep(s, step.key, state)} />
                );
              })}
            </Box>
            <EvidencePanel
              sources={s.sources ?? []}
              discoveredTotal={s.sourcesCount}
              capturedTotal={capturedSources}
              independentSourceCount={independentSourceCount}
              failed={s.failedSourcesCount}
              running={!isTerminal}
              reportLength={s.reportLength}
            />
            <ResearchCheckpoint
              s={s}
              isTerminal={isTerminal}
              onCancel={cancelJob}
              cancelling={cancelling}
              reportContent={hasReaderReport ? (s.artifact?.content ?? s.outputText) : null}
            />
          </Box>
        </Box>
        {!isBrief && !evidenceOnly && isTerminal && !['queued', 'reviewing'].includes(s.reviewRun?.executionStatus ?? s.review?.status ?? s.review?.phase ?? '') && !(s.reviewRun?.claims?.length || s.review?.claims?.length) ? <EvidenceLedger review={s.review} sources={s.sources} /> : null}
      </Box>

      {/* 运行细节 —— 默认折叠；步骤状态已显示在研究过程内 */}
      <JobStatusDisclosure s={s} elapsed={elapsed} />

      {finalStatus === 'partial' ? (
        <Box
          component="div"
          role="alert"
          sx={{ p: space.lg, borderTop: '1px solid', borderColor: 'divider', bgcolor: 'var(--dr-color-warning-container)', color: 'warning.main', ...textSx.body }}
        >
            <Box component="strong" sx={textSx.medium}>{hasReaderReport ? '阶段性研究稿可用' : '已保留研究资料'}</Box>
          {s.errorCode ? <Box component="span" sx={{ ml: space.sm }}>{friendlyMessage({ code: s.errorCode }, '调研在生成结果前中断')}</Box> : null}
          <Typography component="p" sx={{ mt: space.sm, ...textSx.caption, opacity: 0.9 }}>
            {hasReaderReport
              ? '任务在结果确认完成前达到时间上限；阶段性研究稿和已抓取资料已保留，可继续阅读、追问或重新运行。'
              : '任务在生成研究结论前结束；已生成资料快照，可先核对原文或基于这批资料追问。本轮没有可编辑研究稿。'}
          </Typography>
          {s.errorCode ? <Typography component="p" sx={{ mt: space.xs, ...textSx.caption, opacity: 0.75 }}>错误码：{s.errorCode}</Typography> : null}
        </Box>
      ) : s.errorCode ? (
        <Box
          component="div"
          role="alert"
          sx={{ p: space.lg, borderTop: '1px solid', borderColor: 'divider', bgcolor: 'var(--dr-color-danger-container)', color: 'error.main', ...textSx.body }}
        >
          <Box component="strong" sx={textSx.medium}>{friendlyMessage({ code: s.errorCode }, '调研失败')}</Box>
          <Box component="span" sx={{ ml: space.sm, ...textSx.caption, opacity: 0.8 }}>错误码：{s.errorCode}</Box>
          {s.errorMessage ? <Typography component="p" sx={{ mt: space.sm, ...textSx.caption, opacity: 0.9 }}>{s.errorMessage}</Typography> : null}
          {s.errorDetails ? (
            <Box component="details" sx={{ mt: space.sm, p: space.sm, ...surfaceSx, bgcolor: 'action.selected', ...textSx.caption, ...textSx.muted }}>
              <Box component="summary" sx={{ cursor: 'pointer', ...textSx.medium, color: 'text.primary' }}>查看错误详情</Box>
              <Box component="pre" sx={{ mt: space.sm, maxHeight: 224, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'monospace' }}>{JSON.stringify(s.errorDetails, null, 2)}</Box>
            </Box>
          ) : null}
        </Box>
      ) : null}

      {isTerminal ? (
        <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: space.md, p: space.lg, borderTop: '1px solid', borderColor: 'divider' }}>
          <Typography component="div" variant="body2">
            {evidenceOnly ? (
              <Box component="span" sx={textSx.warning}>已保留可核对资料快照；尚未生成研究结论。</Box>
            ) : finalStatus === 'succeeded' ? (
              <Box component="span" sx={textSx.success}>
                {evidenceFreeBrief
                  ? '快速判断已生成，但本轮没有找到可核对资料；未创建调研草稿。'
                  : isBrief ? '快速判断已生成，未创建调研草稿。' : s.reportType === 'slides' ? 'Slides 提纲已生成，可继续编辑或追问。' : s.reportType === 'web_brief' ? '网页简报已生成，可直接阅读、分享或继续追问。' : '研究稿已完成，私有草稿仅你本人可见。'}
              </Box>
            ) : finalStatus === 'partial' ? (
              <Box component="span" sx={textSx.warning}>
                {hasReaderReport
                  ? '阶段性研究稿已保存，关键结论确认未完成。'
                  : '任务已部分完成，已保留抓取资料但未生成可交付结论。'}
              </Box>
            ) : finalStatus === 'failed' ? (
              <Box component="span" sx={textSx.danger}>任务失败，可以回到提交页重新发起。</Box>
            ) : (
              <Box component="span" sx={textSx.muted}>任务已撤回。</Box>
            )}
          </Typography>
          <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', gap: space.sm }}>
            <Button asChild variant="outline" size="sm">
              <Link href="/ai-research">重新调研</Link>
            </Button>
          </Box>
        </Box>
      ) : null}
    </Paper>
  );
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  url: '网页',
  doi: '论文',
  arxiv: 'arXiv',
  summary: '雷达内容',
  research: '历史研究',
  knowledge: '知识库',
};

function EvidencePanel({
  sources,
  discoveredTotal,
  capturedTotal,
  independentSourceCount,
  failed,
  running,
  reportLength,
}: {
  sources: AiJobStatus['sources'];
  discoveredTotal: number;
  capturedTotal: number;
  independentSourceCount: number;
  failed: number;
  running: boolean;
  reportLength: 'brief' | 'standard' | 'deep';
}) {
  // 运行中需要实时看到新资料；完成后先给出数量，把详细清单留给主动核查的用户。
  const [expanded, setExpanded] = useState(false);

  return (
    <Paper component="section" variant="outlined" sx={{ mt: 3, overflow: 'hidden', bgcolor: 'action.selected' }} aria-label="资料与证据">
      <ButtonBase
        component="button"
        type="button"
        sx={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 2, px: 2, py: 1.5, textAlign: 'left', '&:hover': { bgcolor: 'action.hover' } }}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
          <Box component="span" sx={{ display: 'flex', minWidth: 0, alignItems: 'center', gap: space.sm }}>
            <Box component={Radar} sx={{ width: 16, height: 16, color: 'primary.main' }} />
            <Typography component="span" sx={{ ...textSx.label, ...textSx.semibold }}>资料与证据</Typography>
          </Box>
          <Box component="span" sx={{ display: 'flex', minWidth: 0, alignItems: 'center', gap: space.sm, ...textSx.caption, ...textSx.muted }}>
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            检索线索 {discoveredTotal} · 可引用证据 {capturedTotal}
            {capturedTotal > 0 ? ` · 独立域名 ${independentSourceCount}` : ''}
            {failed > 0 ? ` · ${failed} 条未取到正文` : ''}
          </Box>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </Box>
      </ButtonBase>
      {expanded ? (
        <Box component="div" sx={{ px: space.md, py: space.md, borderTop: '1px solid', borderColor: 'divider' }}>
          <Typography component="p" sx={{ mb: space.md, px: space.xs, ...textSx.caption, ...textSx.muted }}>
            来源等级按域名、页面路径和来源类型推断；同一域名的页面只计为一个独立来源，不等同于结论已被证明。
          </Typography>
          {sources.length === 0 ? (
            <Typography component="p" sx={{ px: space.xs, py: space.md, ...textSx.caption, ...textSx.muted }}>
              {running
                ? reportLength === 'deep'
                  ? '正在并行展开多个研究分支；检索线索会先出现，只有取得可核对正文后才会计入可引用证据。'
                  : '正在寻找第一批可用来源…'
                : discoveredTotal > 0
                  ? `发现 ${discoveredTotal} 条检索线索，但该任务没有保存可引用正文。`
                  : '本次任务没有保存可展示的来源。'}
            </Typography>
          ) : (
            <Box component="ul" sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, gap: space.sm, m: 0, p: 0, listStyle: 'none' }}>
              {sources.map((source) => (
                <Box component="li" key={source.id} sx={{ minWidth: 0, px: space.md, py: space.sm, ...surfaceSx, borderRadius: 'var(--dr-radius-medium)' }}>
                  {(() => {
                    const provenance = classifySourceProvenance({ href: source.href, type: source.type, title: source.title });
                    const sourceText = [source.title, source.snippet].filter(Boolean).join('\n');
                    const externalInstruction = hasExternalInstructionSignal(sourceText);
                    return (
                      <>
                  <Box component="div" sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm }}>
                    {source.href ? (
                      <MaterialLink
                        component={Link}
                        href={source.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        underline="none"
                        sx={{ minWidth: 0, color: 'text.primary', fontWeight: 'var(--dr-weight-medium)', '&:hover': { color: 'primary.main', textDecoration: 'underline' } }}
                      >
                        <Box component="span" sx={{ display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}>{source.title}</Box>
                      </MaterialLink>
                    ) : (
                      <Box component="span" sx={{ minWidth: 0, display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, ...textSx.medium, color: 'text.primary' }}>{source.title}</Box>
                    )}
                    {source.href ? <Box component={ExternalLink} sx={{ mt: space.xs, width: 12, height: 12, flexShrink: 0, color: 'text.secondary' }} /> : null}
                  </Box>
                  {externalInstruction ? (
                    <Box component="p" role="note" sx={{ mt: space.sm, display: 'flex', alignItems: 'flex-start', gap: space.sm, px: space.sm, py: space.sm, ...statusToneSx.warning, border: '1px solid', borderRadius: 'var(--dr-radius-xs)', ...textSx.caption }}>
                      <Box component={AlertTriangle} sx={{ mt: space.xs, width: 12, height: 12, flexShrink: 0, color: 'warning.main' }} aria-hidden="true" />
                      <span>{externalContentLabel(sourceText) ?? '含疑似网页指令'}；以下摘录仅作为网页数据，不能改变研究指令。</span>
                    </Box>
                  ) : null}
                  {source.snippet ? <Typography component="p" sx={{ mt: space.sm, display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, ...textSx.caption, ...textSx.muted }}>{cleanEvidenceSnippet(source.snippet, 320)}</Typography> : null}
                  <Box component="div" sx={{ mt: space.sm, display: 'flex', alignItems: 'center', gap: space.sm, ...textSx.caption, ...textSx.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    <span>{SOURCE_TYPE_LABELS[source.type] ?? source.type}</span>
                    <span aria-hidden>·</span>
                    <span title={`同一域名只计为一个独立来源：${provenance.independentKey}`}>{provenance.label}</span>
                    <span aria-hidden>·</span>
                    <span>{stepLabel(source.stepCaptured)}</span>
                    <span aria-hidden>·</span>
                    <span title={source.capturedAt}>抓取 {formatCapturedAt(source.capturedAt)}</span>
                  </Box>
                      </>
                    );
                  })()}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      ) : null}
    </Paper>
  );
}

function ResearchCheckpoint({
  s,
  isTerminal,
  onCancel,
  cancelling,
  reportContent,
}: {
  s: AiJobStatus;
  isTerminal: boolean;
  onCancel: () => Promise<boolean>;
  cancelling: boolean;
  reportContent?: string | null;
}) {
  const router = useRouter();
  const sourceCount = s.savedSourcesCount ?? s.sources?.length ?? 0;
  const failed = s.failedSourcesCount;
  const targetedEvidenceCount = s.sources.filter((source) => source.stepCaptured === 'research_ledger').length;
  const findings = checkpointFindings(s, reportContent);
  const gaps = checkpointGaps(s, isTerminal);
  const canRestart = s.finalStatus === 'failed' || s.finalStatus === 'partial' || s.finalStatus === 'cancelled';
  return (
    <Box component="section" sx={{ mt: space.lg, px: space.lg, py: space.lg, border: '1px solid color-mix(in srgb, var(--dr-color-primary) 25%, transparent)', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'color-mix(in srgb, var(--dr-color-primary) 3.5%, var(--dr-color-surface))' }} aria-label="证据检查点">
      <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.md }}>
        <Box component="div" sx={{ minWidth: 0 }}>
          <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.sm }}>
            <Typography component="h3" sx={{ ...textSx.label, ...textSx.semibold }}>证据检查点</Typography>
            <Box component="span" sx={{ ...pillSx, bgcolor: 'var(--dr-color-primary-container)', color: 'primary.main' }}>{isTerminal ? '本轮已结束' : '可随时纠偏'}</Box>
          </Box>
          <Typography component="p" sx={{ mt: space.xs, ...textSx.caption, ...textSx.muted }}>
            {isTerminal
              ? '下面把本轮已经收集的证据和仍缺的内容集中呈现，帮助你决定是否需要追问、修订或重新研究。'
              : s.reportLength === 'deep'
                ? `任务会继续按启动时的范围执行；当前已保存 ${sourceCount} 条来源${failed > 0 ? `，其中 ${failed} 条获取失败` : ''}。深度研究会先展开多个角度，再补查证据缺口。`
                : `任务会继续按启动时的范围执行；当前已记录 ${sourceCount} 条来源${failed > 0 ? `，其中 ${failed} 条获取失败` : ''}。你可以继续等待，也可以现在收敛范围。`}
          </Typography>
          <Typography component="p" sx={{ mt: space.xs, ...textSx.caption, ...textSx.muted }}>
            原始检索设置：{scopeSummary(s.brief?.scope)} · {s.sourcePolicy === 'only_user_sources' ? '仅使用已选资料' : '网页搜索 + 已选资料'} · {sourceProvenanceSummary(s)}
            {targetedEvidenceCount > 0 ? ` · 后续声明补证新增 ${targetedEvidenceCount} 条` : ''}
          </Typography>
        </Box>
      </Box>
      <Box component="div" sx={{ mt: space.md, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, gap: space.md }}>
        <Box component="div" sx={{ p: space.md, ...surfaceSx, borderColor: 'color-mix(in srgb, var(--dr-color-outline) 70%, transparent)', bgcolor: 'color-mix(in srgb, var(--dr-color-surface) 70%, transparent)', borderRadius: 'var(--dr-radius-medium)' }}>
            <Typography component="h4" sx={{ ...textSx.caption, ...textSx.semibold, color: 'text.primary' }}>已抓到的证据</Typography>
          <Box component="ul" sx={{ mt: space.sm, mb: 0, pl: 0, display: 'grid', gap: space.sm, listStyle: 'none', ...textSx.caption, ...textSx.muted }}>
            {findings.map((finding) => <Box component="li" key={finding} sx={{ display: 'flex', gap: space.sm }}><Box component="span" sx={{ mt: space.sm, width: 4, height: 4, flexShrink: 0, borderRadius: 'var(--dr-radius-pill)', bgcolor: 'primary.main' }} />{finding}</Box>)}
          </Box>
        </Box>
        <Box component="div" sx={{ p: space.md, ...statusToneSx.warning, border: '1px solid', borderRadius: 'var(--dr-radius-medium)' }}>
          <Typography component="h4" sx={{ ...textSx.caption, ...textSx.semibold, color: 'text.primary' }}>还缺什么证据</Typography>
          <Box component="ul" sx={{ mt: space.sm, mb: 0, pl: 0, display: 'grid', gap: space.sm, listStyle: 'none', ...textSx.caption, ...textSx.muted }}>
            {gaps.map((gap) => <Box component="li" key={gap} sx={{ display: 'flex', gap: space.sm }}><Box component="span" sx={{ mt: space.sm, width: 4, height: 4, flexShrink: 0, borderRadius: 'var(--dr-radius-pill)', bgcolor: 'warning.main' }} />{gap}</Box>)}
          </Box>
        </Box>
      </Box>
      <Box component="div" sx={{ mt: space.md, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.sm }}>
        {!isTerminal ? (
          <>
            <Typography component="span" sx={{ ...textSx.caption, ...textSx.muted }}>任务会按启动时的设置继续运行；离开页面不会停止。</Typography>
            <Button type="button" size="xs" variant="outline" onClick={async () => { const cancelled = await onCancel(); if (cancelled) router.push('/ai-research'); }} disabled={cancelling}>
              {cancelling ? '结束中…' : '结束并调整设置'}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => void onCancel()} disabled={cancelling}>
              {cancelling ? '结束中…' : '结束并保留已抓取资料'}
            </Button>
          </>
          ) : s.deliverableStatus === 'evidence_only' ? (
          <>
            <MaterialLink component={Link} href="#research-chat" sx={{ ...textSx.caption, ...textSx.medium, color: 'primary.main', '&:hover': { textDecoration: 'underline' } }}>基于这批资料继续追问</MaterialLink>
            <Button type="button" size="xs" variant="outline" onClick={() => router.push('/ai-research')}>
              重新研究并调整设置
            </Button>
          </>
        ) : canRestart ? (
          <Button type="button" size="xs" variant="outline" onClick={() => router.push('/ai-research')}>
            重新开始并调整设置
          </Button>
        ) : (
          <MaterialLink component={Link} href="#research-chat" sx={{ ...textSx.caption, ...textSx.medium, color: 'primary.main', '&:hover': { textDecoration: 'underline' } }}>继续追问这份研究</MaterialLink>
        )}
      </Box>
    </Box>
  );
}

function scopeSummary(scope: ResearchScope | undefined): string {
  if (!scope) return '不限制资料时间';
  const time = scope.timeRange.preset === 'custom'
    ? `优先 ${scope.timeRange.from ?? '?'} 至 ${scope.timeRange.to ?? '?'} 的资料`
    : ({ any: '不限制资料时间', '7d': '优先最近 7 天', '30d': '优先最近 30 天', '90d': '优先最近 90 天', '1y': '优先最近 1 年' }[scope.timeRange.preset] ?? '不限制资料时间');
  const notes = scope.retrievalNotes ? `其他偏好：${scope.retrievalNotes}` : '';
  return [time, notes].filter(Boolean).join(' · ');
}

function deepResearchActivityLabel(s: AiJobStatus): string {
  const progress = s.researchProgress;
  const total = progress?.totalBranches ?? progress?.branchesTotal ?? 0;
  const completed = progress?.totalBranchesCompleted ?? progress?.branchesCompleted ?? 0;
  const captured = Math.max(s.capturedSourcesCount ?? 0, s.partialSourcesCount ?? 0, progress?.sourcesCaptured ?? 0);
  if (progress?.state === 'reviewing') {
    return `正在整理依据 · ${captured} 条可核对正文`;
  }
  if (progress?.state === 'writing') {
    return `正在根据已抓取正文生成研究稿 · ${captured} 条可核对正文`;
  }
  if (progress?.state === 'verifying') {
    return `正在补查证据缺口 · ${captured} 条可核对正文`;
  }
  if (total > 0 && completed >= total) {
    return `研究分支已完成，正在整理已抓取正文 · ${captured} 条可核对正文`;
  }
  if (progress?.round && progress.rounds) {
    return `正在展开第 ${progress.round}/${progress.rounds} 轮研究分支 · ${captured} 条可核对正文`;
  }
  return `正在展开多个研究分支 · ${captured} 条可核对正文`;
}

function sourceProvenanceSummary(s: AiJobStatus): string {
  const userCount = s.userSourceRefsCount ?? 0;
  const autoCount = s.autoSourceRefsCount ?? 0;
  return autoCount > 0
    ? `你已选 ${userCount} 条 · 系统自动参考 ${autoCount} 条`
    : `你已选 ${userCount} 条`;
}

function checkpointFindings(s: AiJobStatus, reportContent?: string | null): string[] {
  const reportFinding = reportContent ? extractFirstReportSection(reportContent, /摘要|结论|核心判断|summary|conclusion/iu) : null;
  if (reportFinding) return [`报告结论：${reportFinding}`];
  if (reportContent) return ['报告已生成，但没有识别到摘要/结论章节；请切换到“阅读稿”查看原文。'];
  const sourceSignals = (s.sources ?? [])
    .map((source) => source.snippet?.trim())
    .filter((snippet): snippet is string => !!snippet)
    .slice(0, 2)
    .map((snippet) => {
      const cleaned = cleanEvidenceSnippet(snippet, 180);
      return `已抓取原文：${cleaned}${cleaned.length >= 180 ? '…' : ''}`;
    });
  if (sourceSignals.length > 0) return sourceSignals;
  if (s.sourcesCount > 0) return [`当前记录了 ${s.sourcesCount} 条候选来源，正在整理为可核验结论。`];
  return ['暂未形成可引用的主要发现。'];
}

function checkpointGaps(s: AiJobStatus, isTerminal: boolean): string[] {
  const gaps: string[] = [];
  // "evidence_only" describes an early-stop terminal outcome. While a deep
  // research job is still running, the absence of a report is expected and
  // should not be presented as a missing deliverable.
  if (isTerminal && s.deliverableStatus === 'evidence_only') {
    gaps.push('本轮没有生成研究结论；已保存的资料只能作为下一轮研究输入。');
  }
  if (s.failedSourcesCount > 0) gaps.push(`${s.failedSourcesCount} 条资料获取失败，需要用其他来源补齐。`);
  if (s.sources.length === 0) gaps.push('还没有保存可核验来源，当前不能把结论称为已证实。');
  const coverageGaps = Object.values(s.researchProgress?.sourceCoverage ?? {})
    .filter((item) => item.status !== 'covered')
    .map((item) => {
      const required = item.requiredCaptured ?? 2;
      return `${item.label}：已抓取 ${item.captured}/${required} 条正文（独立页面 ${item.discovered} 条）。`;
    });
  gaps.push(...coverageGaps);
  if (s.researchSufficiency?.status === 'insufficient') {
    const gapSummary = summarizeResearchSufficiencyGaps(s.researchSufficiency);
    if (gapSummary.cellCount > 0) {
      gaps.push(`研究计划缺口：还有 ${gapSummary.cellCount} 个方案 × 决策维度覆盖单元格待补证。`);
      gaps.push(...gapSummary.groups.map((group) => `${group.option}：待补 ${group.dimensions.join('、')}`));
    }
    gaps.push(...gapSummary.otherGaps.map((gap) => `研究计划缺口：${gap}`));
  }
  if (isTerminal && s.reportType === 'summary_brief') {
    gaps.push('本轮是轻量摘要，不建立正式研究稿的声明账本；需要核验结论时建议重新运行“研究稿”。');
  }
  if (!isTerminal && gaps.length === 0) {
    const discovered = Math.max(
      s.sourcesCount ?? 0,
      s.savedSourcesCount ?? 0,
      s.researchProgress?.sourcesDiscovered ?? 0,
    );
    const captured = Math.max(
      s.capturedSourcesCount ?? 0,
      s.partialSourcesCount ?? 0,
      s.researchProgress?.sourcesCaptured ?? 0,
    );
    if (captured < discovered) {
      gaps.push(`还需核对 ${discovered - captured} 条检索线索，确认它们是否能支撑后续判断。`);
    } else {
      const totalBranches = s.researchProgress?.branchesTotal ?? s.researchProgress?.totalBranches ?? 0;
      const completedBranches = s.researchProgress?.branchesCompleted ?? s.researchProgress?.totalBranchesCompleted ?? 0;
      const remainingBranches = Math.max(0, totalBranches - completedBranches);
      gaps.push(
        remainingBranches > 0
          ? `完成剩余 ${remainingBranches} 个研究方向，形成可核对的初步结论。`
          : '继续整理证据，形成可核对的初步结论。',
      );
    }
  }
  if (isTerminal && gaps.length === 0) {
    gaps.push(s.researchSufficiency?.status === 'not_assessed'
      ? '本轮没有可自动判断的资料覆盖范围；使用前请结合来源确认关键结论。'
      : '本轮没有发现明确的资料覆盖缺口；这不等于每条结论都已经有直接依据。');
  }
  return gaps;
}

function citationPendingCount(review: ReviewDetails | null): number {
  if (!review) return 0;
  if (typeof review.citation_pending_count === 'number') return Math.max(0, review.citation_pending_count);
  return (review.claims ?? []).filter((claim) =>
    claimIsCitationRelationship(claim)
    && ['unverified', 'unsupported'].includes(claim.verdict ?? '')
  ).length;
}

function extractFirstReportSection(content: string, headingPattern: RegExp): string | null {
  const lines = content.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^#{1,3}\s+/u.test(line) && headingPattern.test(line));
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s+/u.test(line)) break;
    const normalized = line.replace(/^\s*[-*+]\s+/u, '').replace(/[*_`]/gu, '').trim();
    if (normalized) body.push(normalized);
  }
  const text = body.join(' ').replace(/\s+/gu, ' ').trim();
  return text ? text.slice(0, 360) : null;
}

function ReviewPanel({
  review,
  reviewRun,
  researchSufficiency,
  draftResearchId,
}: {
  review: ReviewDetails | null;
  reviewRun: ReviewRunDetails | null;
  researchSufficiency: ResearchSufficiency | null;
  draftResearchId?: string | null;
}) {
  const params = useParams<{ jobId: string }>();
  // A stale run is historical evidence only. Its claim verdicts must not be
  // reused as current-version support or pending work after the draft edits.
  const runClaims = reviewRun?.executionStatus !== 'stale' && Array.isArray(reviewRun?.claims)
    ? reviewRun.claims
    : [];
  const claims = reviewRun?.executionStatus === 'stale'
    ? []
    : runClaims.length > 0
      ? runClaims
      : Array.isArray(review?.claims) ? review.claims : [];
  const factualClaims = claims.filter((claim) => claimIsFactual(claim) && !claimIsCitationRelationship(claim));
  const claimCounts = countClaimDisplayStatuses(claims);
  const decisions = reviewRun?.decisions ?? [];
  const decisionByClaim = new Map<string, ReviewDecisionRecord>();
  for (const decision of decisions) {
    if (decision.claimId) decisionByClaim.set(decision.claimId, decision);
  }
  const publicationGate = reviewRun?.publicationGate ?? getReviewPublicationGate({
    executionStatus: reviewRun?.executionStatus,
    outcome: reviewRun?.outcome,
    coverageStatus: reviewCoverageStatus(reviewRun?.summary),
    researchSufficiencyStatus: researchSufficiency?.status,
    claims,
    decisions,
  });
  const sufficiencyGapSummary = researchSufficiency
    ? summarizeResearchSufficiencyGaps(researchSufficiency)
    : null;
  const pendingClaims = claims.filter((claim) => (
    claimIsFactual(claim)
    && claimDisplayStatus(claim) !== 'supported'
    && !decisionResolvesClaim(claim, decisionByClaim.get(reviewClaimId(claim) ?? ''))
  ));
  // Recompute counts from the current claim inventory. Persisted summary
  // counters predate claim_type and may count research-process observations
  // as facts until the next review run is written.
  const factualClaimCount = claims.length > 0
    ? factualClaims.length
    : review?.factual_claim_count ?? 0;
  const citationPendingCount = review?.citation_pending_count
    ?? claims.filter((claim) => claimIsCitationRelationship(claim) && ['unverified', 'unsupported'].includes(claim.verdict ?? '')).length;
  const evidenceBindingRepairedCount = claims.filter((claim) => (
    claim.evidence?.resolver === 'captured-source-reconciler'
  )).length;
  const runStatus = reviewRun?.executionStatus;
  const displayStatus = runStatus === 'queued'
    ? 'queued'
    : runStatus === 'reviewing'
      ? 'reviewing'
      : runStatus === 'unavailable'
        ? 'review_unavailable'
      : runStatus === 'stale'
          ? 'stale'
          : runStatus === 'completed'
            ? publicationGateStatus(publicationGate.status, reviewRun?.outcome)
            : reviewDisplayStatus(review);
  const displayLabel = displayStatus === 'review_unavailable'
    ? '暂时无法确认'
    : displayStatus === 'stale'
      ? '版本已更新，需要重新确认'
      : publicationGate.status === 'coverage_insufficient'
        ? '资料范围有缺口'
      : publicationGate.status === 'research_insufficient'
        ? '资料范围有缺口'
      : publicationGate.status === 'publish_with_disclosure'
        ? '有待确认项'
      : publicationGate.status === 'clear' && researchSufficiency?.status === 'not_assessed'
        ? '可以参考 · 资料范围未确认'
      : displayStatus === 'passed'
        ? '可以直接参考'
      : displayStatus === 'needs_action'
        ? '需要确认'
      : displayStatus === 'queued' || displayStatus === 'reviewing'
        ? '结果整理中'
      : reviewDisplayLabel({ ...(review ?? {}), status: displayStatus });
  const reviewQueued = displayStatus === 'queued';
  const reviewRunning = displayStatus === 'reviewing';
  const reviewUnavailable = displayStatus === 'review_unavailable';
  const reviewStale = displayStatus === 'stale';
  const summary = reviewQueued || reviewRunning
    ? '结果已经生成，依据还在整理；完成后会自动更新。'
    : reviewStale
      ? '研究内容已经变更，上一轮依据不能代表当前版本。'
      : reviewUnavailable
        ? '当前没有完成依据确认；这不代表结论错误，稍后可以重试。'
        : publicationGate.hardBlockCount > 0
          ? `${publicationGate.hardBlockCount} 条结论与来源不一致，需要修改后再使用。`
          : publicationGate.status === 'coverage_insufficient'
            ? '本轮没有覆盖全部需要确认的结论，不能把“未发现问题”当成“已确认”。'
            : publicationGate.status === 'research_insufficient'
              ? '现有资料不足以支撑完整研究范围，建议补充资料后再下结论。'
              : pendingClaims.length > 0
                ? `${pendingClaims.length} 条结论还需要你确认；其余结果可以先参考。`
                : publicationGate.status === 'publish_with_disclosure'
                  ? `主要结论已有对应资料，但仍保留 ${publicationGate.disclosedCount} 条待确认说明。`
                  : researchSufficiency?.status === 'not_assessed'
                    ? '主要结论已有对应资料，但资料范围尚未完整判断。'
                    : '主要结论都有对应资料；仍可打开来源查看原文。';

  const queryClient = useQueryClient();
  const [reReviewing, setReReviewing] = useState(false);
  const [reReviewError, setReReviewError] = useState<string | null>(null);
  const [decisionBusy, setDecisionBusy] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [evidenceTaskBusy, setEvidenceTaskBusy] = useState<string | null>(null);
  const [evidenceTaskError, setEvidenceTaskError] = useState<string | null>(null);
  const [evidenceTasks, setEvidenceTasks] = useState<Record<string, { status: string; sourceCount?: number }>>({});
  const [decisionRequest, setDecisionRequest] = useState<{
    claim: ReviewClaim;
    action: 'accept_uncertainty' | 'challenge_support';
  } | null>(null);
  const [decisionReason, setDecisionReason] = useState('');

  async function reReview() {
    if (!draftResearchId) return;
    setReReviewing(true);
    setReReviewError(null);
    try {
      const r = await fetch(`/api/researches/${draftResearchId}/review`, {
        method: 'POST',
        cache: 'no-store',
      });
      if (!r.ok) {
        const err = await toApiHttpError(r, '重新检查失败');
        throw err;
      }
      // The endpoint queues work and returns 202.  Let the durable run
      // become the single source of truth instead of painting a queued run
      // as a completed result in the client cache.
      await queryClient.invalidateQueries({ queryKey: ['ai-job', params.jobId] });
    } catch (e) {
      setReReviewError(e instanceof Error ? e.message : '重新检查失败，请稍后再试。');
    } finally {
      setReReviewing(false);
    }
  }

  async function recordDecision(
    claim: ReviewClaim,
    action: 'accept_uncertainty' | 'request_verification' | 'confirm_support' | 'challenge_support',
  ) {
    if (!draftResearchId || !reviewRun?.id || !reviewClaimId(claim)) return;
    const defaultReason = action === 'accept_uncertainty'
      ? '我确认这是低/中风险的待验证项，并会在研究风险或后续行动中保留它。'
      : action === 'challenge_support'
        ? '我认为当前摘录并不能支持这条声明，请重新核对证据关系。'
      : action === 'request_verification'
        ? '当前证据不足以发布这条声明，请按当前已保存资料重新核对。'
        : undefined;
    if (action !== 'confirm_support') {
      if (action === 'request_verification') {
        await submitDecision(claim, action, defaultReason);
      } else {
        setDecisionReason(defaultReason ?? '');
        setDecisionRequest({ claim, action });
      }
      return;
    }
    await submitDecision(claim, action);
  }

  async function submitDecision(
    claim: ReviewClaim,
    action: 'accept_uncertainty' | 'request_verification' | 'confirm_support' | 'challenge_support',
    reason?: string,
  ) {
    if (!draftResearchId || !reviewRun?.id || !reviewClaimId(claim)) return;
    const claimId = reviewClaimId(claim)!;
    if (action === 'accept_uncertainty' && !reason?.trim()) return;
    setDecisionBusy(claimId);
    setDecisionError(null);
    try {
      const response = await fetch(`/api/researches/${draftResearchId}/review/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: reviewRun.id,
          claimId,
          action,
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
        }),
      });
      if (!response.ok) throw await toApiHttpError(response, '保存处理失败');
      await queryClient.invalidateQueries({ queryKey: ['ai-job', params.jobId] });
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : '保存处理失败，请刷新后重试。');
    } finally {
      setDecisionBusy(null);
    }
  }

  async function requestEvidenceTask(claim: ReviewClaim) {
    if (!draftResearchId || !reviewRun?.id || !reviewClaimId(claim)) return;
    const claimId = reviewClaimId(claim)!;
    setEvidenceTaskBusy(claimId);
    setEvidenceTaskError(null);
    try {
      const response = await fetch(`/api/researches/${draftResearchId}/evidence-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: reviewRun.id, claimId }),
      });
      if (!response.ok) throw await toApiHttpError(response, '创建定向补证任务失败');
      const payload = await response.json() as { task?: { id?: string; status?: string; sourceCount?: number } };
      const taskId = payload.task?.id;
      if (!taskId) throw new Error('补证任务没有返回任务编号');
      setEvidenceTasks((current) => ({
        ...current,
        [claimId]: { status: payload.task?.status ?? 'queued', sourceCount: payload.task?.sourceCount },
      }));

      // The task is durable and continues if this page closes. Polling here is
      // only for immediate feedback; the GET endpoint also performs the
      // idempotent evidence-ledger → new-review-run handoff.
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const taskResponse = await fetch(`/api/researches/${draftResearchId}/evidence-tasks/${taskId}`, { cache: 'no-store' });
        if (!taskResponse.ok) continue;
        const taskPayload = await taskResponse.json() as {
          task?: { status?: string; sourceCount?: number };
        };
        const status = taskPayload.task?.status ?? 'researching';
        setEvidenceTasks((current) => ({
          ...current,
          [claimId]: { status, sourceCount: taskPayload.task?.sourceCount },
        }));
        if (['completed', 'failed', 'stale'].includes(status)) {
          if (status === 'completed') {
            await queryClient.invalidateQueries({ queryKey: ['ai-job', params.jobId] });
          }
          return;
        }
      }
    } catch (error) {
      setEvidenceTaskError(error instanceof Error ? error.message : '定向补证任务创建失败，请稍后重试。');
    } finally {
      setEvidenceTaskBusy(null);
    }
  }

  async function confirmDecision() {
    if (!decisionRequest || !decisionReason.trim()) return;
    const request = decisionRequest;
    setDecisionRequest(null);
    await submitDecision(request.claim, request.action, decisionReason);
    setDecisionReason('');
  }

  const canReReview = !reReviewing
    && !reviewQueued
    && !reviewRunning
    // Coverage is an execution-quality failure, not a claim-level edit
    // decision. It must be recoverable from the same revision; otherwise a
    // report with an incomplete inventory is effectively stuck unless the
    // user makes an unrelated content edit.
    && (reviewUnavailable || reviewStale || !reviewRun || publicationGate.status === 'coverage_insufficient')
    && !!draftResearchId;

  return (
    <section aria-label="使用建议">
      {researchSufficiency?.matrix ? (
        <DecisionCoverageMatrixView matrix={researchSufficiency.matrix} recommendation={researchSufficiency.recommendation} />
      ) : null}
      {researchSufficiency?.status === 'insufficient' ? (
        <Box component="div" sx={{ mb: space.md, border: '1px solid', borderColor: 'warning.main', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'var(--dr-color-warning-container)', px: space.md, py: space.sm, ...textSx.caption, color: 'warning.main' }}>
          <Box component="p" sx={textSx.medium}>资料范围还有缺口</Box>
          <Box component="p" sx={{ mt: space.xs }}>
            {sufficiencyGapSummary?.cellCount
              ? `当前还有 ${sufficiencyGapSummary.cellCount} 个方案 × 决策维度覆盖单元格待补证。`
              : '当前结果还有待补证的资料范围。'}
            {' '}如果要做完整比较，请补充这些资料。
          </Box>
          {sufficiencyGapSummary && sufficiencyGapSummary.groups.length > 0 ? (
            <Box component="details" sx={{ mt: space.sm, border: '1px solid', borderColor: 'warning.main', borderRadius: 'var(--dr-radius-small)', bgcolor: 'color-mix(in srgb, var(--dr-color-surface) 35%, transparent)', px: space.md, py: space.sm }}>
              <Box component="summary" sx={{ cursor: 'pointer', ...textSx.medium }}>按方案查看待补维度</Box>
              <Box component="div" sx={{ mt: space.sm, display: 'grid', gap: space.sm, ...textSx.caption }}>
                {sufficiencyGapSummary.groups.map((group) => (
                  <Box component="p" key={group.option}>
                    <Box component="span" sx={textSx.medium}>{group.option}</Box>
                    <Box component="span" sx={{ ml: space.sm }}>{group.dimensions.join('、')}</Box>
                  </Box>
                ))}
              </Box>
            </Box>
          ) : null}
          {sufficiencyGapSummary && sufficiencyGapSummary.otherGaps.length > 0 ? (
            <Box component="details" sx={{ mt: space.sm, border: '1px solid', borderColor: 'warning.main', borderRadius: 'var(--dr-radius-small)', bgcolor: 'color-mix(in srgb, var(--dr-color-surface) 35%, transparent)', px: space.md, py: space.sm }}>
              <Box component="summary" sx={{ cursor: 'pointer', ...textSx.medium }}>查看其他缺口</Box>
              <Box component="ul" sx={{ mt: space.sm, mb: 0, pl: space.lg, display: 'grid', gap: space.xs, ...textSx.caption }}>
                {sufficiencyGapSummary.otherGaps.map((gap) => <li key={gap}>{gap}</li>)}
              </Box>
            </Box>
          ) : null}
          <MaterialLink component={Link} href="/ai-research" underline="none" sx={{ mt: space.xs, display: 'inline-flex', ...textSx.medium, color: 'primary.main', '&:hover': { textDecoration: 'underline' } }}>补充资料并重新研究</MaterialLink>
        </Box>
      ) : null}
      <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
        <Box component="div">
          <Typography component="h3" sx={{ ...textSx.body, ...textSx.semibold }}>使用建议</Typography>
          <Typography component="p" sx={{ ...textSx.caption, ...textSx.muted }}>先看这份结果是否适合直接参考，需要时再查看依据。</Typography>
        </Box>
        <Box component="div" sx={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
          {canReReview ? (
            <Button type="button" variant="default" size="sm" onClick={() => void reReview()} disabled={reReviewing}>
              <Box component={RotateCw} sx={{ width: 14, height: 14, animation: reReviewing ? 'researchSpin 1s linear infinite' : 'none', '@keyframes researchSpin': { to: { transform: 'rotate(360deg)' } } }} />
              {reReviewing ? '整理中…' : '重新整理依据'}
            </Button>
          ) : pendingClaims.length > 0 ? (
            <Button asChild variant="default" size="sm">
              <Link href="#quality-check-evidence">查看并处理待确认结论</Link>
            </Button>
          ) : researchSufficiency?.status === 'insufficient' ? (
            <Button asChild variant="default" size="sm">
              <Link href="/ai-research">补充资料并重新研究</Link>
            </Button>
          ) : null}
        </Box>
      </Box>
      {reviewStale ? (
        <Box component="div" sx={{ mt: space.sm, border: '1px solid', borderColor: 'warning.main', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'var(--dr-color-warning-container)', px: space.md, py: space.sm, ...textSx.caption, color: 'warning.main' }}>
          <Box component="p" sx={textSx.medium}>研究内容已经变更，需要重新整理依据。</Box>
          <Box component="p" sx={{ mt: space.xs }}>上一轮依据仍保留在历史记录中，但不能用于当前版本。</Box>
        </Box>
      ) : review ? (
        reviewQueued || reviewRunning ? (
          <Box component="div" sx={{ mt: space.sm, border: '1px solid color-mix(in srgb, var(--dr-color-primary) 20%, transparent)', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'color-mix(in srgb, var(--dr-color-primary) 4%, transparent)', px: space.md, py: space.sm, ...textSx.caption, ...textSx.muted }}>
            <Box component="p" sx={{ ...textSx.medium, color: 'text.primary' }}>结果正在整理</Box>
            <Box component="p" sx={{ mt: space.xs }}>你可以继续阅读或追问；完成后这里会自动更新。</Box>
          </Box>
        ) : reviewUnavailable ? (
          <Box component="div" sx={{ mt: space.sm, border: '1px solid', borderColor: 'warning.main', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'var(--dr-color-warning-container)', px: space.md, py: space.sm, ...textSx.caption, color: 'warning.main' }}>
            <Box component="p" sx={textSx.medium}>暂时无法确认</Box>
            <Box component="p" sx={{ mt: space.xs }}>这不代表结论错误；当前版本只是还没有得到完整的依据确认。</Box>
          </Box>
        ) : null
      ) : (
        <Typography component="p" sx={{ mt: space.sm, ...textSx.caption, ...textSx.muted }}>检查结果还没有生成；你可以先阅读研究稿，完成后这里会自动显示需要注意的结论。</Typography>
      )}
      {!reviewQueued && !reviewRunning && !reviewUnavailable && !reviewStale && reviewRun?.executionStatus === 'completed' ? (
        <Box component="div" sx={{
          mt: space.md, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: space.sm,
          border: '1px solid', borderRadius: 'var(--dr-radius-medium)', px: space.md, py: space.sm, ...textSx.caption,
          ...(publicationGate.status === 'blocked'
            ? { borderColor: 'color-mix(in srgb, var(--dr-color-danger) 50%, transparent)', bgcolor: 'color-mix(in srgb, var(--dr-color-danger-container) 30%, transparent)' }
            : pendingClaims.length > 0 || publicationGate.status !== 'clear'
              ? { borderColor: 'warning.main', bgcolor: 'var(--dr-color-warning-container)' }
              : { borderColor: 'color-mix(in srgb, var(--dr-color-success) 50%, transparent)', bgcolor: 'color-mix(in srgb, var(--dr-color-success-container) 30%, transparent)' }),
        }} aria-label="结果摘要">
          <Box component="div">
            <Box component="span" sx={{ ...textSx.medium, color: 'text.primary' }}>{displayLabel}</Box>
            <Box component="span" sx={{ ml: space.sm, ...textSx.muted }}>{summary}</Box>
          </Box>
        </Box>
      ) : null}
      {reReviewError ? (
        <Typography component="p" role="alert" sx={{ mt: space.sm, ...textSx.caption, ...textSx.danger }}>{reReviewError}</Typography>
      ) : null}
      {decisionError ? (
        <Typography component="p" role="alert" sx={{ mt: space.sm, ...textSx.caption, ...textSx.danger }}>{decisionError}</Typography>
      ) : null}
      {evidenceTaskError ? (
        <Typography component="p" role="alert" sx={{ mt: space.sm, ...textSx.caption, ...textSx.danger }}>{evidenceTaskError}</Typography>
      ) : null}
      <Box component="details" id="quality-check-evidence" sx={{ mt: space.md, border: '1px solid', borderColor: 'divider', borderRadius: 'var(--dr-radius-small)', bgcolor: 'color-mix(in srgb, var(--dr-color-surface-container) 20%, transparent)', p: space.sm, ...textSx.caption }}>
        <Box component="summary" sx={{ cursor: 'pointer', ...textSx.medium, color: 'text.primary' }}>
          {pendingClaims.length > 0 ? `查看并处理 ${pendingClaims.length} 条待确认结论` : '查看结论依据'}
        </Box>
        <Box component="div" sx={{ mt: space.sm, display: 'grid', gap: space.sm, border: '1px solid', borderColor: 'divider', borderRadius: 'var(--dr-radius-small)', bgcolor: 'color-mix(in srgb, var(--dr-color-surface) 50%, transparent)', p: space.md, ...textSx.caption, ...textSx.muted }}>
          <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', columnGap: space.lg, rowGap: space.xs }}>
            <span>关键结论 {factualClaimCount}</span>
            <span>有直接依据 {claimCounts.supported}</span>
            <span>需要确认 {claimCounts.unverified}</span>
            <span>来源不一致 {claimCounts.contradicted}</span>
          </Box>
          {citationPendingCount > 0 ? <p>有 {citationPendingCount} 条引用关系还没有完成确认。</p> : null}
          {evidenceBindingRepairedCount > 0 ? <p>已从保存的资料中找到 {evidenceBindingRepairedCount} 条可对照摘录；这不等同于结论已经成立。</p> : null}
          {claims.length > 0 ? (
            <Box component="div" sx={{ '& > * + *': { borderTop: '1px solid', borderColor: 'divider' }, border: '1px solid', borderColor: 'divider', borderRadius: 'var(--dr-radius-small)', bgcolor: 'background.paper' }}>
              {claims.map((claim, index) => (
                <ReviewClaimCard
                  key={claim.claim_id ?? `${claim.claim ?? 'claim'}-${index}`}
                  claim={claim}
                  jobId={params.jobId}
                  draftResearchId={draftResearchId}
                  reviewRunId={reviewRun?.id}
                  decision={decisionByClaim.get(reviewClaimId(claim) ?? '')}
                  decisionBusy={decisionBusy === reviewClaimId(claim)}
                  onDecision={recordDecision}
                  reviewUnavailable={reviewUnavailable}
                  onChallenge={claimDisplayStatus(claim) === 'supported' ? recordDecision : undefined}
                  evidenceTask={evidenceTasks[reviewClaimId(claim) ?? '']}
                  evidenceTaskBusy={evidenceTaskBusy === reviewClaimId(claim)}
                  onEvidenceTask={requestEvidenceTask}
                />
              ))}
            </Box>
          ) : <p>本轮没有保存逐条声明；请直接查看研究资料中的原文。</p>}
          {pendingClaims.length > 0 ? (
            <Box component="p" sx={{ borderTop: '1px solid', borderColor: 'divider', pt: space.sm }}>如果修改正文，相关结果会随当前版本重新检查。</Box>
          ) : null}
        </Box>
      </Box>
      <AppDialog
        open={Boolean(decisionRequest)}
        onClose={() => { setDecisionRequest(null); setDecisionReason(''); }}
        title={decisionRequest?.action === 'challenge_support' ? '质疑这条证据关系' : '确认保留这条待验证项'}
        description={decisionRequest?.action === 'challenge_support'
          ? '系统会用当前已保存资料重新核对，正文不会改变。完成后会更新依据状态。'
          : '这不会修改正文。确认后可以发布，但读者会看到这条结论仍保留为待确认项；后续修改正文后，这个决定会随版本一起失效。'}
        actions={(
          <>
            <Button type="button" variant="outline" onClick={() => { setDecisionRequest(null); setDecisionReason(''); }}>
              取消
            </Button>
            <Button type="button" onClick={() => void confirmDecision()} disabled={!decisionReason.trim() || decisionBusy !== null}>
              {decisionBusy ? '处理中…' : decisionRequest?.action === 'challenge_support' ? '重新核对证据' : '保存处理决定'}
            </Button>
          </>
        )}
      >
          <Box component="div" sx={{ display: 'grid', gap: space.md }}>
            <Box component="div" sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'color-mix(in srgb, var(--dr-color-surface-container) 30%, transparent)', px: space.md, py: space.sm, ...textSx.caption, color: 'text.primary' }}>
              {decisionRequest?.claim.claim}
            </Box>
            <Box component="label" sx={{ display: 'grid', gap: space.sm, ...textSx.caption, ...textSx.medium }} htmlFor="review-decision-reason">
              处理依据 <Box component="span" sx={{ fontWeight: 'var(--dr-weight-regular)', ...textSx.muted }}>（必填）</Box>
              <Textarea
                id="review-decision-reason"
                value={decisionReason}
                onChange={(event) => setDecisionReason(event.target.value)}
                placeholder={decisionRequest?.action === 'challenge_support'
                  ? '例如：摘录描述的是背景，不足以支持这条结论。'
                  : '例如：这是低风险开放问题，当前没有足够资料，但我会在风险项中保留说明。'}
                rows={4}
                sx={{ '& textarea': { resize: 'vertical' } }}
              />
            </Box>
          </Box>
      </AppDialog>
    </section>
  );
}

function DecisionCoverageMatrixView({
  matrix,
  recommendation,
}: {
  matrix: NonNullable<ResearchSufficiency['matrix']>;
  recommendation: ResearchSufficiency['recommendation'];
}) {
  const evidenceCells = matrix.cells.filter((cell) => cell.state === 'evidence').length;
  const cellMap = new Map(matrix.cells.map((cell) => [`${cell.option}:${cell.dimension}`, cell]));
  const stateLabel = { evidence: '有证据', not_found: '未找到', needs_test: '待实测' } as const;
  const stateSx = {
    evidence: { borderColor: 'color-mix(in srgb, var(--dr-color-success) 50%, transparent)', bgcolor: 'color-mix(in srgb, var(--dr-color-success-container) 35%, transparent)', color: 'success.main' },
    not_found: { borderColor: 'divider', bgcolor: 'color-mix(in srgb, var(--dr-color-surface-container) 35%, transparent)', color: 'text.secondary' },
    needs_test: { borderColor: 'warning.main', bgcolor: 'var(--dr-color-warning-container)', color: 'warning.main' },
  } as const;
  return (
    <Box component="details" open={!matrix.complete} sx={{ mb: space.md, border: '1px solid', borderColor: 'color-mix(in srgb, var(--dr-color-outline) 80%, transparent)', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'background.paper' }}>
      <Box component="summary" sx={{ display: 'flex', cursor: 'pointer', listStyle: 'none', alignItems: 'center', justifyContent: 'space-between', gap: space.md, px: space.md, py: space.sm, ...textSx.caption, '&::-webkit-details-marker': { display: 'none' } }}>
        <Box component="span" sx={textSx.medium}>问题覆盖矩阵</Box>
        <Box component="span" sx={{ ...textSx.caption, color: matrix.complete ? 'success.main' : 'warning.main' }}>
          {evidenceCells}/{matrix.cells.length} 格有证据
        </Box>
      </Box>
      <Box component="div" sx={{ borderTop: '1px solid', borderColor: 'divider', px: space.md, pb: space.md, pt: space.sm }}>
        <Typography component="p" sx={{ mb: space.sm, ...textSx.caption, ...textSx.muted }}>
          这是研究完成门禁：每个方案 × 决策维度必须逐格处理；“待实测”不等于“没有问题”。
        </Typography>
        <Box component="div" sx={{ overflowX: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 'var(--dr-radius-small)' }}>
          <Box component="table" sx={{ minWidth: 760, width: '100%', borderCollapse: 'collapse', ...textSx.caption }}>
            <Box component="thead" sx={{ bgcolor: 'color-mix(in srgb, var(--dr-color-surface-container) 35%, transparent)', color: 'text.secondary', textAlign: 'left' }}>
              <tr><Box component="th" sx={{ borderBottom: '1px solid', borderColor: 'divider', px: space.sm, py: space.sm, ...textSx.medium }}>方案</Box>{matrix.dimensions.map((dimension) => <Box component="th" key={dimension} sx={{ borderBottom: '1px solid', borderColor: 'divider', px: space.sm, py: space.sm, ...textSx.medium }}>{dimension}</Box>)}</tr>
            </Box>
            <Box component="tbody">
              {matrix.options.map((option) => (
                <tr key={option}>
                  <Box component="th" sx={{ borderBottom: '1px solid color-mix(in srgb, var(--dr-color-outline) 50%, transparent)', px: space.sm, py: space.sm, textAlign: 'left', ...textSx.medium, color: 'text.primary' }}>{option}</Box>
                  {matrix.dimensions.map((dimension) => {
                    const cell = cellMap.get(`${option}:${dimension}`);
                    const state = cell?.state ?? 'not_found';
                    return (
                      <Box component="td" key={dimension} sx={{ borderBottom: '1px solid color-mix(in srgb, var(--dr-color-outline) 50%, transparent)', px: space.sm, py: space.sm }}>
                        <Box component="span" sx={{ display: 'inline-flex', border: '1px solid', borderRadius: 'var(--dr-radius-small)', px: space.sm, py: space.xs, ...textSx.caption, ...stateSx[state] }}
                          title={cell?.evidenceGap ?? undefined}
                        >
                          {stateLabel[state]}{cell?.evidenceCount ? ` · ${cell.evidenceCount}` : ''}
                        </Box>
                        {cell?.evidenceGap ? <Typography component="p" sx={{ mt: space.xs, maxWidth: 160, ...textSx.caption, color: 'warning.main' }}>{cell.evidenceGap}</Typography> : null}
                      </Box>
                    );
                  })}
                </tr>
              ))}
            </Box>
          </Box>
        </Box>
        {recommendation.status === 'incomplete' ? <Typography component="p" sx={{ mt: space.sm, ...textSx.caption, color: 'warning.main' }}>结构化推荐尚不完整：缺少 {recommendation.missingFields.join('、')}。</Typography> : null}
      </Box>
    </Box>
  );
}

function ReviewClaimCard({
  claim,
  jobId,
  draftResearchId,
  reviewRunId,
  decision,
  decisionBusy = false,
  evidenceTask,
  evidenceTaskBusy = false,
  onDecision,
  onChallenge,
  onEvidenceTask,
  reviewUnavailable = false,
}: {
  claim: ReviewClaim;
  jobId: string;
  draftResearchId?: string | null;
  reviewRunId?: string;
  decision?: ReviewDecisionRecord;
  decisionBusy?: boolean;
  evidenceTask?: { status: string; sourceCount?: number };
  evidenceTaskBusy?: boolean;
  onDecision?: (
    claim: ReviewClaim,
    action: 'accept_uncertainty' | 'request_verification' | 'confirm_support' | 'challenge_support',
  ) => void;
  onChallenge?: (
    claim: ReviewClaim,
    action: 'challenge_support',
  ) => void;
  onEvidenceTask?: (claim: ReviewClaim) => void;
  reviewUnavailable?: boolean;
}) {
  const citationRelationship = claimIsCitationRelationship(claim);
  const hasReconciledExcerpt = claim.evidence?.resolver === 'captured-source-reconciler';
  const hasCandidateExcerpt = claimIsFactual(claim) && Boolean(claim.evidence?.excerpt);
  const judgmentLabel = claimJudgmentLabel(claim);
  const judgmentStatus = claimJudgmentStatus(claim);
  const status: '已建立引用' | '有直接依据' | '有资料可对照' | '来源不一致' | '还缺直接依据' | '还没确认' | '待确认' | '结果不一致' = judgmentLabel
    ? judgmentLabel === '这条还没检查完' ? '还没确认' : judgmentLabel === '已识别，尚未判断' ? '待确认' : '结果不一致'
    : citationRelationship
    ? '已建立引用'
      : claimDisplayStatus(claim) === 'supported'
      ? '有直接依据'
      : claimDisplayStatus(claim) === 'contradicted'
        ? '来源不一致'
      : hasReconciledExcerpt || hasCandidateExcerpt
        ? '有资料可对照'
        : '还缺直接依据';
  const statusSx = status === '有直接依据' || status === '已建立引用'
    ? { bgcolor: 'var(--dr-color-success-container)', color: 'success.main' }
    : status === '来源不一致'
      ? { bgcolor: 'var(--dr-color-danger-container)', color: 'error.main' }
      : { bgcolor: 'var(--dr-color-warning-container)', color: 'warning.main' };
  const needsAction = claimIsFactual(claim) && !reviewUnavailable && (judgmentStatus !== 'settled' || status !== '有直接依据');
  // The action is derived from this claim's own evidence relation. A global
  // "there are sources" flag is not enough: unrelated sources should not
  // force a meaningless re-check instead of a real evidence search.
  const nextAction = claim.nextAction ?? reviewClaimNextAction(claim);
  const risk = claim.risk?.toLowerCase();
  const canAcceptUncertainty = needsAction
    && claimEvidenceStatus(claim) === 'unverified'
    && risk !== 'high'
    && Boolean(onDecision);
  const canRequestVerification = needsAction && Boolean(onDecision);
  const canRequestEvidence = needsAction && Boolean(onEvidenceTask);
  const claimText = (claim.claim ?? '').trim();
  const encodedClaim = encodeURIComponent(claimText.slice(0, 1_200));
  const location = reviewClaimLocation(claim);
  const reviewRunQuery = reviewRunId ? `&reviewRunId=${encodeURIComponent(reviewRunId)}` : '';
  const verifyHref = `/ai-research/${jobId}?reviewClaim=${encodedClaim}${reviewRunQuery}#research-chat`;
  const editHref = draftResearchId
    ? `/researches/${draftResearchId}/edit?reviewClaim=${encodedClaim}${location ? `&reviewStart=${location[0]}&reviewEnd=${location[1]}` : ''}#editor-body`
    : null;

  return (
    <Box component="article" sx={{ px: space.md, py: space.md }}>
      <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm }}>
        <Typography component="h5" sx={{ minWidth: 0, flex: 1, ...textSx.caption, ...textSx.semibold, color: 'text.primary' }}>{claimText || '未命名声明'}</Typography>
        <Box component="span" sx={{ flexShrink: 0, display: 'inline-flex', borderRadius: 'var(--dr-radius-pill)', px: space.sm, py: space.xs, ...textSx.caption, ...textSx.medium, ...statusSx }}>{status}</Box>
      </Box>
      {claim.reason ? <Typography component="p" sx={{ mt: space.sm, ...textSx.caption, ...textSx.muted }}>{citationRelationship && reviewUnavailable ? '已建立来源回链，但本轮没有完成确认。' : claim.evidence?.resolver === 'captured-source-reconciler' ? '找到可对照资料，但还不能确认它支持这句话。' : claim.reason.includes('审核结果没有提供') ? '当前没有能直接对照的资料。' : claim.reason}</Typography> : null}
      {judgmentStatus !== 'settled' ? (
        <Typography component="p" sx={{ mt: space.sm, ...textSx.caption, color: 'warning.main' }}>
          {judgmentStatus === 'disputed'
            ? '两次独立核对给出了不同判断，系统不会替你判定真伪。'
            : '这条声明已经被识别，但还没有形成可用的最终判断。'}
        </Typography>
      ) : null}
      <Box component="div" sx={{ mt: space.sm, border: '1px solid', borderColor: 'divider', borderRadius: 'var(--dr-radius-small)', bgcolor: 'color-mix(in srgb, var(--dr-color-surface) 70%, transparent)', px: space.md, py: space.sm, ...textSx.caption }}>
        <Box component="span" sx={{ ...textSx.medium, color: 'text.primary' }}>可对照的原文：</Box>
        <Box component="span" sx={textSx.muted}>{claim.evidence?.excerpt || '没有保存可核对摘录'}</Box>
      </Box>
      <Box component="div" sx={{ mt: space.sm, display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: space.lg, rowGap: space.xs, ...textSx.caption }}>
        {claim.evidence?.source_url ? (
          <MaterialLink component="a" href={claim.evidence.source_url} target="_blank" rel="noreferrer noopener" underline="none" sx={{ display: 'inline-flex', alignItems: 'center', gap: space.xs, color: 'primary.main', '&:hover': { textDecoration: 'underline' } }}>
            打开来源 <ExternalLink size={12} />
          </MaterialLink>
        ) : <Box component="span" sx={textSx.muted}>没有可打开的来源</Box>}
        {claim.evidence?.observed_at ? <Box component="span" sx={textSx.muted}>观察时间：{claim.evidence.observed_at}</Box> : null}
        {claim.evidence?.source_type ? (
          <Box component="span" sx={textSx.muted}>
            来源类型：{classifySourceProvenance({ href: claim.evidence.source_url, type: claim.evidence.source_type }).label}
          </Box>
        ) : null}
        {claim.evidence?.published_at ? <Box component="span" sx={textSx.muted}>发布时间：{claim.evidence.published_at}</Box> : null}
        {claim.evidence?.evidence_strength && claim.evidence.evidence_strength !== 'unknown' ? <Box component="span" sx={textSx.muted}>证据强度：{claim.evidence.evidence_strength}</Box> : null}
      </Box>
      {claim.evidence?.counterexamples?.length ? <Typography component="p" sx={{ mt: space.sm, ...textSx.caption, color: 'warning.main' }}>反例/限制：{claim.evidence.counterexamples.join('；')}</Typography> : null}
      {needsAction ? (
        <Box component="div" sx={{ mt: space.md, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.sm }}>
          {nextAction === 'reverify_current_sources' && canRequestVerification ? (
            <Button type="button" size="xs" variant="outline" onClick={() => onDecision?.(claim, 'request_verification')} disabled={decisionBusy}>
              {decisionBusy ? '排队中…' : '重新核对'}
            </Button>
          ) : null}
          {nextAction === 'find_more_evidence' && canRequestEvidence ? (
            <Button type="button" size="xs" variant="outline" onClick={() => onEvidenceTask?.(claim)} disabled={evidenceTaskBusy || decisionBusy}>
              {evidenceTaskBusy ? '补证中…' : '补充证据'}
            </Button>
          ) : null}
          {claim.evidence?.source_url ? (
            <Button asChild type="button" size="xs" variant="outline">
              <Link href={verifyHref}>对照来源</Link>
            </Button>
          ) : null}
          {editHref ? (
            <Button asChild type="button" size="xs" variant="ghost">
              <Link href={editHref}><PenLine size={12} />定位正文</Link>
            </Button>
          ) : null}
          {canAcceptUncertainty ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => onDecision?.(claim, 'accept_uncertainty')} disabled={decisionBusy}>
              {decisionBusy ? '保存中…' : '暂时保留'}
            </Button>
          ) : null}
          {nextAction === 'edit_claim' ? (
            <Typography component="span" sx={{ ...textSx.caption, ...textSx.danger }}>来源不一致；请修改表述或删除后重新检查</Typography>
          ) : risk === 'high' ? (
            <Typography component="span" sx={{ ...textSx.caption, ...textSx.danger }}>高风险项必须修改或补足证据</Typography>
          ) : status === '来源不一致' ? (
            <Typography component="span" sx={{ ...textSx.caption, ...textSx.danger }}>来源不一致，不能直接接受；请修改表述或删除</Typography>
          ) : (
            <Typography component="span" sx={{ ...textSx.caption, ...textSx.muted }}>修改正文后需要重新确认</Typography>
          )}
        </Box>
      ) : null}
      {status === '有直接依据' && !reviewUnavailable && onChallenge ? (
        <Box component="div" sx={{ mt: space.md, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.sm }}>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => onChallenge(claim, 'challenge_support')}
            disabled={decisionBusy}
          >
            {decisionBusy ? '排队中…' : '证据不匹配？重新核对'}
          </Button>
          <Typography component="span" sx={{ ...textSx.caption, ...textSx.muted }}>如果这条依据不对，可以要求重新确认。</Typography>
        </Box>
      ) : null}
      {evidenceTask ? (
        <Typography component="p" sx={{ mt: space.sm, ...textSx.caption, ...textSx.muted }}>
          {evidenceTask.status === 'queued' || evidenceTask.status === 'researching'
            ? '正在针对这条声明寻找新的直接来源；原研究稿暂不改变。'
            : evidenceTask.status === 'evidence_ready' || evidenceTask.status === 'review_queued'
              ? `已找到 ${evidenceTask.sourceCount ?? 0} 条新资料，正在用新资料重新确认当前版本。`
              : evidenceTask.status === 'completed'
                ? '定向补证和新一轮依据整理已完成，请查看更新后的证据关系。'
                : '定向补证未完成，原研究稿没有改变。'}
        </Typography>
      ) : null}
    </Box>
  );
}

function EvidenceLedger({ review, sources }: { review: ReviewDetails | null; sources: AiJobStatus['sources'] }) {
  const claims = Array.isArray(review?.claims) ? review.claims : [];
  const counts = countClaimDisplayStatuses(claims);
  const reviewUnavailable = reviewDisplayStatus(review) === 'review_unavailable';
  const factualClaimCount = claims.length > 0
    ? claims.filter((claim) => claimIsFactual(claim) && !claimIsCitationRelationship(claim)).length
    : review?.factual_claim_count ?? 0;
  const citationCount = claims.length > 0
    ? claims.filter(claimIsCitationRelationship).length
    : review?.citation_count ?? 0;
  const citationPending = citationPendingCount(review);
  const inspectableSources = sources.filter((source) => source.snippet?.trim()).slice(0, 8);
  const ledgerTitle = claims.length > 0
    ? reviewUnavailable ? '报告引用关系' : '结论与证据账本'
    : '按来源核查';
  return (
    <Box component="section" sx={{ mt: space.xl, overflow: 'hidden', border: '1px solid color-mix(in srgb, var(--dr-color-primary) 20%, transparent)', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'color-mix(in srgb, var(--dr-color-primary) 2.5%, transparent)' }} aria-label={ledgerTitle}>
      <Box component="div" sx={{ borderBottom: '1px solid color-mix(in srgb, var(--dr-color-primary) 10%, transparent)', px: space.lg, py: space.md }}>
        <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
          <Box component="div">
            <Typography component="h3" sx={{ ...textSx.body, ...textSx.semibold }}>{ledgerTitle}</Typography>
          <Typography component="p" sx={{ mt: space.xs, ...textSx.caption, ...textSx.muted }}>
              {claims.length > 0 && reviewUnavailable
                ? '这里记录报告与来源的对应关系；本轮确认未完成，因此不把任何一条标记为已支持或存在冲突。'
                : claims.length > 0
                ? '逐条查看报告判断、保存的来源摘录和依据状态；有来源地址不代表结论已被支持。'
                : '本轮没有建立“结论—来源”对应关系；下面只列出可供人工核查的已抓取正文，不把来源本身当作已支持结论。'}
          </Typography>
          </Box>
          {claims.length > 0 ? (
            reviewUnavailable ? (
              <Box component="span" sx={{ display: 'inline-flex', borderRadius: 'var(--dr-radius-pill)', border: '1px solid', borderColor: 'warning.main', bgcolor: 'var(--dr-color-warning-container)', px: space.sm, py: space.xs, ...textSx.caption, color: 'warning.main' }}>
                {citationPending > 0
                  ? `已保留 ${citationPending} 条引用关系`
                  : factualClaimCount > 0
                    ? `${factualClaimCount} 条事实声明待核对`
                    : '语义核验未完成'}
              </Box>
            ) : (
              <Box component="div" sx={{ display: 'flex', gap: space.sm, ...textSx.caption, fontVariantNumeric: 'tabular-nums' }}>
                <Box component="span" sx={{ borderRadius: 'var(--dr-radius-pill)', bgcolor: 'var(--dr-color-success-container)', px: space.sm, py: space.xs, color: 'success.main' }}>已支持 {counts.supported}</Box>
                <Box component="span" sx={{ borderRadius: 'var(--dr-radius-pill)', bgcolor: 'var(--dr-color-warning-container)', px: space.sm, py: space.xs, color: 'warning.main' }}>需要确认 {counts.unverified}</Box>
                <Box component="span" sx={{ borderRadius: 'var(--dr-radius-pill)', bgcolor: 'var(--dr-color-danger-container)', px: space.sm, py: space.xs, color: 'error.main' }}>冲突 {counts.contradicted}</Box>
              </Box>
            )
          ) : null}
        </Box>
      </Box>
      {claims.length === 0 ? (
        <Box component="div" sx={{ px: space.lg, py: space.md }}>
          <Typography component="p" sx={{ ...textSx.caption, ...textSx.muted }}>
            这通常表示依据整理超时、不可用，或历史任务没有保存逐条结果。请优先核对报告中的关键判断；“没有记录”不等于所有结论都已被证明。
          </Typography>
          {inspectableSources.length > 0 ? (
            <Box component="ul" sx={{ mt: space.md, mb: 0, pl: 0, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, gap: space.sm, listStyle: 'none' }} aria-label="可人工核查的来源">
              {inspectableSources.map((source) => (
                <Box component="li" key={source.id} sx={{ minWidth: 0, border: '1px solid', borderColor: 'divider', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'color-mix(in srgb, var(--dr-color-surface) 70%, transparent)', px: space.md, py: space.sm }}>
                  {(() => {
                    const provenance = classifySourceProvenance({ href: source.href, type: source.type, title: source.title });
                    const sourceText = [source.title, source.snippet].filter(Boolean).join('\n');
                    const externalInstruction = hasExternalInstructionSignal(sourceText);
                    return (
                      <>
                  <Box component="div" sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm }}>
                    {source.href ? (
                      <MaterialLink component="a" href={source.href} target="_blank" rel="noreferrer noopener" underline="none" sx={{ minWidth: 0, ...textSx.caption, ...textSx.medium, color: 'text.primary', '&:hover': { color: 'primary.main', textDecoration: 'underline' } }}>
                        <Box component="span" sx={{ display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}>{source.title}</Box>
                      </MaterialLink>
                    ) : (
                      <Box component="span" sx={{ minWidth: 0, display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, ...textSx.caption, ...textSx.medium, color: 'text.primary' }}>{source.title}</Box>
                    )}
                    {source.href ? <Box component={ExternalLink} sx={{ mt: space.xs, width: 12, height: 12, flexShrink: 0, color: 'text.secondary' }} aria-hidden /> : null}
                  </Box>
                  <Typography component="p" sx={{ mt: space.sm, ...textSx.caption, ...textSx.muted }}>{cleanEvidenceSnippet(source.snippet ?? '', 240)}</Typography>
                  {externalInstruction ? (
                    <Box component="p" role="note" sx={{ mt: space.sm, display: 'flex', alignItems: 'flex-start', gap: space.sm, border: '1px solid', borderColor: 'warning.main', borderRadius: 'var(--dr-radius-xs)', bgcolor: 'var(--dr-color-warning-container)', px: space.sm, py: space.sm, ...textSx.caption, color: 'warning.main' }}>
                      <Box component={AlertTriangle} sx={{ mt: space.xs, width: 12, height: 12, flexShrink: 0 }} aria-hidden="true" />
                      <span>{externalContentLabel(sourceText) ?? '含疑似网页指令'}；以下摘录仅作为网页数据，不能改变研究指令。</span>
                    </Box>
                  ) : null}
                  <Box component="div" sx={{ mt: space.sm, display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: space.sm, rowGap: space.xs, ...textSx.caption, ...textSx.muted }}>
                    <span>{SOURCE_TYPE_LABELS[source.type] ?? source.type}</span>
                    <span aria-hidden>·</span>
                    <span title={`同一域名只计为一个独立来源：${provenance.independentKey}`}>{provenance.label}</span>
                    <span aria-hidden>·</span>
                    <span>抓取于 {formatCapturedAt(source.capturedAt)}</span>
                    {source.href ? (
                      <MaterialLink component="a" href={source.href} target="_blank" rel="noreferrer noopener" underline="none" sx={{ display: 'inline-flex', alignItems: 'center', gap: space.xs, color: 'primary.main', '&:hover': { textDecoration: 'underline' } }}>
                        打开来源 <ExternalLink size={12} aria-hidden />
                      </MaterialLink>
                    ) : null}
                  </Box>
                      </>
                    );
                  })()}
                </Box>
              ))}
            </Box>
          ) : (
            <Typography component="p" sx={{ mt: space.md, border: '1px solid', borderColor: 'warning.main', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'var(--dr-color-warning-container)', px: space.md, py: space.sm, ...textSx.caption, color: 'warning.main' }}>
              本轮没有保存可核对的原文摘录，只能把报告视为需要确认的草稿。
            </Typography>
          )}
          {sources.length > inspectableSources.length ? (
            <Typography component="p" sx={{ mt: space.sm, ...textSx.caption, ...textSx.muted }}>
              另有 {sources.length - inspectableSources.length} 条已保存资料可在上方“研究资料”中查看；它们不会自动支撑报告结论。
            </Typography>
          ) : null}
        </Box>
      ) : null}
      {claims.length > 0 ? (
      <Box component="details" open={!reviewUnavailable} sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
        <Box component="summary" sx={{ cursor: 'pointer', px: space.lg, py: space.md, ...textSx.caption, ...textSx.medium, color: 'text.primary' }}>
          {reviewUnavailable
            ? `查看资料关系明细 · ${citationCount || claims.length} 条（完成后显示结论关系）`
            : `查看逐条依据 · ${claims.length} 条`}
        </Box>
      <Box component="div" sx={{ '& > * + *': { borderTop: '1px solid', borderColor: 'divider' } }}>
        {claims.map((claim, index) => {
          const citationRelationship = claimIsCitationRelationship(claim);
            const nonFactualDisposition = !claimIsFactual(claim) && !citationRelationship;
            const status = citationRelationship
            ? '已建立引用'
            : nonFactualDisposition
            ? '非结论内容'
            : reviewUnavailable
            ? '需要确认'
            : claimDisplayStatus(claim) === 'supported'
            ? '已支持'
            : claimDisplayStatus(claim) === 'contradicted' ? '存在冲突' : '需要确认';
          const claimStatusSx = status === '已支持' || status === '已建立引用'
            ? { bgcolor: 'var(--dr-color-success-container)', color: 'success.main' }
            : status === '存在冲突' ? { bgcolor: 'var(--dr-color-danger-container)', color: 'error.main' }
              : status === '非结论内容' ? { bgcolor: 'action.selected', color: 'text.secondary' }
              : { bgcolor: 'var(--dr-color-warning-container)', color: 'warning.main' };
          return (
            <Box component="article" key={`${claim.claim ?? 'claim'}-${index}`} sx={{ px: space.lg, py: space.md }}>
              <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm }}>
                <Typography component="h4" sx={{ minWidth: 0, flex: 1, ...textSx.body, ...textSx.medium }}>{claim.claim || '未命名声明'}</Typography>
                <Box component="span" sx={{ flexShrink: 0, display: 'inline-flex', borderRadius: 'var(--dr-radius-pill)', px: space.sm, py: space.xs, ...textSx.caption, ...textSx.medium, ...claimStatusSx }}>{status}</Box>
              </Box>
              <Box component="div" sx={{ mt: space.sm, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.sm, ...textSx.caption, ...textSx.muted }}>
                <Box component="span" sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 'var(--dr-radius-pill)', px: space.sm, py: space.xs }}>{claimKindLabel(claim)}</Box>
                <Box component="span">{claimKindDescription(claim)}</Box>
              </Box>
              {claim.reason ? <Typography component="p" sx={{ mt: space.sm, ...textSx.caption, ...textSx.muted }}>{citationRelationship && reviewUnavailable ? '已建立来源回链，尚未完成语义支持判断。' : claim.reason}</Typography> : null}
              <Box component="div" sx={{ mt: space.sm, border: '1px solid', borderColor: 'divider', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'color-mix(in srgb, var(--dr-color-surface) 70%, transparent)', px: space.md, py: space.sm, ...textSx.caption }}>
                <Box component="span" sx={{ ...textSx.medium, color: 'text.primary' }}>来源摘录：</Box>
                <Box component="span" sx={textSx.muted}>{claim.evidence?.excerpt || '没有保存原文摘录，因此不能把这条声明称为已支持。'}</Box>
              </Box>
              {(() => {
                const matchedSource = findEvidenceSource(claim, sources);
                return matchedSource ? (
                  <Box component="div" sx={{ mt: space.sm, border: '1px solid color-mix(in srgb, var(--dr-color-primary) 15%, transparent)', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'color-mix(in srgb, var(--dr-color-primary) 3%, transparent)', px: space.md, py: space.sm, ...textSx.caption }}>
                    <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: space.sm, rowGap: space.xs }}>
                      <Box component="span" sx={{ ...textSx.medium, color: 'text.primary' }}>来源：{matchedSource.title}</Box>
                      <Box component="span" sx={textSx.muted}>{SOURCE_TYPE_LABELS[matchedSource.type] ?? matchedSource.type}</Box>
                      <Box component="span" sx={textSx.muted}>抓取于 {formatCapturedAt(matchedSource.capturedAt)}</Box>
                    </Box>
                    {matchedSource.snippet ? <Typography component="p" sx={{ mt: space.xs, ...textSx.muted }}>{matchedSource.snippet}</Typography> : null}
                  </Box>
                ) : null;
              })()}
              <Box component="div" sx={{ mt: space.sm, display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: space.lg, rowGap: space.xs, ...textSx.caption, ...textSx.muted }}>
                {claim.evidence?.source_url ? (
                  <MaterialLink component="a" href={claim.evidence.source_url} target="_blank" rel="noreferrer noopener" underline="none" sx={{ display: 'inline-flex', alignItems: 'center', gap: space.xs, color: 'primary.main', '&:hover': { textDecoration: 'underline' } }}>
                    打开来源 <ExternalLink size={12} />
                  </MaterialLink>
                ) : <Box component="span">没有可打开的来源地址</Box>}
                {claim.evidence?.observed_at ? <Box component="span">观察时间：{claim.evidence.observed_at}</Box> : null}
              </Box>
            </Box>
          );
          })}
      </Box>
      </Box>
      ) : null}
    </Box>
  );
}

function claimKindLabel(claim: ReviewClaim): string {
  if (claim.claim_type === 'research_process' || claimIsResearchProcessObservation(claim)) return '研究过程观察';
  if (claim.claim_type === 'interpretation') return '观点 / 推断';
  if (claim.claim_type === 'citation_relationship') return '报告引用';
  if (claim.risk?.toLowerCase() === 'opinion') return '建议 / 观点';
  if (claim.verdict?.toLowerCase() === 'not_applicable') return '非结论内容';
  if (claim.evidence?.resolver === 'captured-source-citation') return '报告引用';
  if (claim.evidence?.excerpt) return '事实声明';
  return '推断 / 需要确认';
}

function claimKindDescription(claim: ReviewClaim): string {
  if (claim.claim_type === 'research_process' || claimIsResearchProcessObservation(claim)) return '由本轮资料账本和抓取记录说明，不是需要逐条核对的外部事实';
  if (claim.claim_type === 'interpretation') return '这是观点、推断或建议，需要结合原文和上下文判断';
  if (claim.claim_type === 'citation_relationship') return '只记录报告与来源的连接，不代表来源已经支持这句话';
  if (claim.risk?.toLowerCase() === 'opinion') return '这是观点或建议，不会被当成外部事实证明';
  if (claim.verdict?.toLowerCase() === 'not_applicable') return '这是建议、推测或其他非事实内容';
  if (claim.evidence?.resolver === 'captured-source-citation') {
    return claim.evidence.excerpt ? '已找到报告引用的来源摘录，但尚未确认它直接支持这句话' : '报告引用了来源，但本轮没有保存可核对摘录';
  }
  if (claim.evidence?.excerpt) return '存在可展开的原文或权威摘录';
  return '当前没有足够原文证据支持';
}

function findEvidenceSource(claim: ReviewClaim, sources: AiJobStatus['sources']): AiJobStatus['sources'][number] | null {
  const evidenceUrl = claim.evidence?.source_url;
  if (!evidenceUrl) return null;
  const normalized = normalizeUrl(evidenceUrl);
  return sources.find((source) => source.href && normalizeUrl(source.href) === normalized) ?? null;
}

function normalizeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./u, '');
    const port = parsed.port && !((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80'))
      ? `:${parsed.port}`
      : '';
    const pathname = parsed.pathname.replace(/\/$/u, '') || '/';
    return `${parsed.protocol.toLowerCase()}//${hostname}${port}${pathname}${parsed.search}`.toLowerCase();
  } catch {
    return value.replace(/\/$/u, '').toLowerCase();
  }
}

function formatCapturedAt(value: string | null | undefined): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function stepLabel(step: string | null | undefined): string {
  if (!step) return '—';
  if (step === 'research_ledger') return '声明补证';
  return STEPS.find((item) => item.key === step)?.label ?? '处理中';
}

/** 终态/审核态/排队态的本地化标签;未知 enum 不静默 fallback。 */
function jobStatusLabel(s: AiJobStatus): string {
  const map: Record<string, string> = {
    queued: '排队中',
    running: '进行中',
    partial: '部分完成',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  const key = s.finalStatus ?? s.status;
  if (key && map[key]) return map[key];
  return `未知状态 · ${key ?? 'null'}`;
}

function formatElapsed(s: AiJobStatus, now: number): string {
  const start = s.startedAt ?? s.createdAt;
  if (!start) return '—';
  const end = s.completedAt ?? new Date(now).toISOString();
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
}

function stepState(s: AiJobStatus, idx: number): StepState {
  const stepKey = STEPS[idx].key;
  const activeIdx = stepIndexShared(s.currentStep ?? s.errorStage);
  const terminalProblem = s.finalStatus === 'failed' || s.finalStatus === 'partial';
  // A report may already exist while fact review is still the active
  // publication gate. Keep the five research steps truthful and show the
  // review step as the failure/current boundary instead of painting every
  // step as failed or completed at once.
  if (terminalProblem && (s.review?.phase === 'reviewing' || s.review?.status === 'reviewing')) {
    if (activeIdx > idx || (stepKey === 'write' && activeIdx >= idx)) return 'done';
    return 'waiting';
  }
  if (s.errorStage === stepKey && terminalProblem) return 'error';
  if (s.review?.phase === 'reviewing' || s.review?.status === 'reviewing' || s.review?.phase === 'completed' || s.finalStatus === 'succeeded') return 'done';
  if (s.finalStatus === 'cancelled') return activeIdx > idx ? 'done' : 'waiting';
  if (activeIdx > idx) return 'done';
  if (activeIdx === idx) return terminalProblem ? 'error' : 'current';
  return 'waiting';
}

function countForStep(s: AiJobStatus, stepKey: string, state: StepState): string | null {
  if (stepKey === 'search') {
    const saved = Math.max(s.savedSourcesCount ?? 0, s.sources?.length ?? 0);
    const captured = Math.max(s.capturedSourcesCount ?? 0, s.partialSourcesCount ?? 0, s.researchProgress?.sourcesCaptured ?? 0);
    if (saved > 0 && captured > 0 && captured !== saved) return `${saved} 条已保存 · ${captured} 条可核对正文`;
    if (saved > 0) return `${saved} 条已保存`;
    if (captured > 0) return `${captured} 条可核对正文`;
    if (s.sourcesCount > 0) return `${s.sourcesCount} 条候选来源`;
  }
  if (stepKey === 'write' && s.finalStatus === 'succeeded') {
    return s.reportType === 'summary_brief' ? '已生成摘要' : '已生成草稿';
  }
  if (state === 'error' && s.errorStage === stepKey && s.errorCode) {
    return s.errorCode;
  }
  return null;
}

const STEP_LABELS: Record<StepState, string> = {
  done: '完成',
  current: '当前步骤',
  attention: '需处理',
  error: '失败',
  waiting: '等待中',
};

function TimelineStep({
  step,
  state,
  count,
  last = false,
}: {
  step: TimelineStepData;
  state: StepState;
  count: string | null;
  last?: boolean;
}) {
  const Icon = step.icon;
  const dotSx = {
    done: { borderColor: 'success.main', bgcolor: 'var(--dr-color-success-container)', color: 'success.main' },
    current: { borderColor: 'primary.main', bgcolor: 'primary.main', color: 'primary.contrastText', boxShadow: '0 0 0 4px color-mix(in srgb, var(--dr-color-primary) 12%, transparent)' },
    attention: { borderColor: 'warning.main', bgcolor: 'var(--dr-color-warning-container)', color: 'warning.main' },
    error: { borderColor: 'error.main', bgcolor: 'var(--dr-color-danger-container)', color: 'error.main' },
    waiting: { borderColor: 'divider', bgcolor: 'background.paper', color: 'text.secondary' },
  }[state];
  /* 三态 label 让屏幕阅读器读出当前步骤的状态(色弱/单视觉用户也能感知) */
  const stateLabel = { done: '已完成', current: '进行中', attention: '需处理', error: '失败', waiting: '等待' }[state];
  return (
    <Box component="div" sx={{ position: 'relative', pb: last ? 0 : space.xl }}>
      <Box
        component="span"
        sx={{ position: 'absolute', left: -32.8, top: 0, display: 'grid', width: 20, height: 20, placeItems: 'center', borderRadius: 'var(--dr-radius-pill)', border: '2px solid', ...dotSx }}
        role="img"
        aria-label={`${step.label}:${stateLabel}`}
      >
        <Box component={Icon} aria-hidden sx={{ width: 10, height: 10 }} />
      </Box>
      <Box component="div" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: space.sm, rowGap: space.xs }}>
        <Typography component="span" sx={{ ...textSx.body, ...textSx.medium, ...(state === 'waiting' ? textSx.muted : {}) }}>{step.label}</Typography>
        <Typography component="span" sx={{ ...textSx.caption, color: state === 'current' ? 'primary.main' : state === 'attention' ? 'warning.main' : state === 'error' ? 'error.main' : 'text.secondary' }}>
          {STEP_LABELS[state]}
        </Typography>
        {count ? <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...textSx.caption, ...textSx.muted }} title={count}>{count}</Box> : null}
      </Box>
      <Typography component="p" sx={{ mt: space.xs, ...textSx.caption, ...textSx.muted }} title={step.desc}>
        {step.desc}
      </Typography>
    </Box>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <Box component="div" sx={{ display: 'flex', minWidth: 0, gap: space.sm }}>
      <Box component="span" sx={{ flexShrink: 0, ...textSx.muted }}>{label}:</Box>
      <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(mono ? { fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' } : {}) }}>{value}</Box>
    </Box>
  );
}

/**
 * 任务状态详情 disclosure —— 默认折叠，只露一行关键摘要。
 *
 * 默认信息：耗时 + 资料数量 + 当前步骤 —— 把用户关心的进度放在第一层。
 * 完整字段（已抓取 / 失败 / 出错于）藏在展开后。
 *
 * 与 ScoreReasonDisclosure 同样的设计：debug 字段不该污染主屏，需要时再展开。
 */
function JobStatusDisclosure({
  s,
  elapsed,
}: {
  s: AiJobStatus;
  elapsed: string;
}) {
  const [open, setOpen] = useState(false);
  const completed = s.finalStatus === 'succeeded';
  const stepSummary = completed ? ' · 已完成' : s.currentStep ? ` · 当前 ${stepLabel(s.currentStep)}` : '';
  const savedSourcesCount = s.savedSourcesCount ?? s.sourcesCount;
  const summary = `${elapsed} · ${savedSourcesCount} 条已保存资料${stepSummary}` + (s.costCents > 0 ? ` · $${(s.costCents / 100).toFixed(2)}` : '');

  return (
    <Box component="div" sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
      <ButtonBase
        component="button"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="job-status-details"
        sx={{ display: 'flex', width: '100%', cursor: 'pointer', alignItems: 'center', justifyContent: 'space-between', gap: space.sm, px: space.lg, py: space.sm, textAlign: 'left', transition: `background-color var(--dr-motion-fast)`, '&:hover': { bgcolor: 'color-mix(in srgb, var(--dr-color-surface-container) 40%, transparent)' } }}
      >
        <Box component="span" sx={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: space.sm, whiteSpace: 'nowrap', ...textSx.caption, ...textSx.medium, ...textSx.muted }}>
          {open ? (
            <ChevronDown size={14} aria-hidden />
          ) : (
            <ChevronRight size={14} aria-hidden />
          )}
          更多信息
        </Box>
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', ...textSx.caption, ...textSx.muted }}>{summary}</Box>
      </ButtonBase>
      {open && (
        <Box
          component="div"
          id="job-status-details"
          role="region"
          aria-label="更多信息"
          sx={{ display: 'grid', columnGap: space.xl, rowGap: space.sm, borderTop: '1px solid', borderColor: 'divider', bgcolor: 'color-mix(in srgb, var(--dr-color-surface-container) 40%, transparent)', px: space.lg, py: space.md, gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' }, ...textSx.caption }}
        >
          <DetailRow label={completed ? '任务状态' : '正在处理'} value={completed ? '已完成' : stepLabel(s.currentStep)} />
          <DetailRow label="已保存来源" value={String(savedSourcesCount)} mono />
          <DetailRow label="已抓取" value={String(s.partialSourcesCount)} mono />
          <DetailRow label="抓取失败" value={String(s.failedSourcesCount)} mono />
          <DetailRow label="出错于" value={stepLabel(s.errorStage)} />
          <DetailRow label="耗时" value={elapsed} mono />
          {s.tokenInputTotal > 0 ? (
            <DetailRow label="输入 Tokens" value={s.tokenInputTotal.toLocaleString()} mono />
          ) : null}
          {s.tokenOutputTotal > 0 ? (
            <DetailRow label="输出 Tokens" value={s.tokenOutputTotal.toLocaleString()} mono />
          ) : null}
          {s.costCents > 0 ? (
            <DetailRow label="本次费用" value={`$${(s.costCents / 100).toFixed(2)}`} mono />
          ) : null}
        </Box>
      )}
    </Box>
  );
}
