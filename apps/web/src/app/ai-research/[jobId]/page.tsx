'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
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
import { MarkdownPreview } from '@/components/MarkdownPreview';
import {
  stepIndex as stepIndexShared,
  type DeepResearchProgress,
} from '@/lib/ai-progress';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { retryOnceAi } from '@/lib/errors/friendly';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { PageHeader } from '@/components/domain/PageHeader';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
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
  decisionLabel,
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
import { ResearchChatPanel } from '@/components/ai-research/ResearchChatPanel';
import { AiResearchWorkspaceSidebar } from '@/components/ai-research/AiResearchWorkspaceSidebar';
import { DeepResearchProgressCard } from '@/components/ai-research/DeepResearchProgressCard';
import type { AiResearchConversationDetail } from '@/lib/ai-research-chat';
import type { ResearchSufficiency } from '@/lib/research-sufficiency';
import type { ResearchBrief, ResearchScope } from '@deep-research/shared/schemas';

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
    ? 'border-warning-border/70 bg-warning-bg/40 text-warning-fg'
    : gate.status === 'blocked'
      ? 'border-status-failed-border/70 bg-status-failed-bg/40 text-status-failed-fg'
      : gate.status === 'clear'
        ? 'border-status-succeeded-border/70 bg-status-succeeded-bg/40 text-status-succeeded-fg'
        : 'border-warning-border/70 bg-warning-bg/40 text-warning-fg';
  return (
    <span
      className={cn('rounded-full border px-2 py-0.5 text-[10px] font-medium', tone)}
      aria-label={`结果状态：${label}`}
    >
      {label}
    </span>
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
      if (data.state.status === 'error') return false;
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
    <div className="mx-auto max-w-shell">
      <PageHeader
        variant="workbench"
        title={
          <span aria-live="polite" aria-atomic="true">
            {q.isError ? '无法加载调研' : q.data?.finalStatus && TERMINAL.has(q.data.finalStatus) ? '调研结果' : '调研进行中'}
          </span>
        }
        description={
          q.data
            ? `${researchOutputLabel(q.data.reportType)} · ${q.data.topic ?? '本次调研'}`
            : '正在读取调研任务状态…'
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
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
          </div>
        }
        className="mb-5"
      />

      <div className="mt-4 grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="order-1 min-w-0 lg:order-2">
          {q.isLoading ? (
            <JobStatusSkeleton />
          ) : q.isError ? (
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
        </div>
        <div className="order-2 lg:order-1">
          {/* 结果页的主任务是读懂本轮研究；完整任务历史在新建工作台中统一管理。 */}
          <AiResearchWorkspaceSidebar showTaskHistory={false} showRecentArtifacts={false} />
        </div>
      </div>
    </div>
  );
}

/** 步骤形加载骨架 —— 与实际页面布局对齐,避免单一大方块。 */
function JobStatusSkeleton() {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
        <div className="shrink-0 space-y-1 text-right">
          <Skeleton className="ml-auto h-8 w-20" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      </div>
      <Skeleton className="h-2 w-full" />
      <div className="mt-4 space-y-3">
        <Skeleton className="h-3 w-32" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-md" />
          ))}
        </div>
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
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
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="border-b border-border px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge kind="job" value={statusLabel} label={statusLabel} />
              {finalStatus === 'succeeded' && !evidenceFreeBrief ? (
                <ReviewGateChip gate={publicationGate} executionStatus={reviewExecutionStatus} researchSufficiency={researchSufficiency} />
              ) : null}
              <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground tabular-nums" aria-label={`研究耗时 ${elapsed}`}>
                <span>研究耗时 {elapsed}</span>
              </span>
            </div>
            <h2 className="mt-3 text-xl font-semibold tracking-tight">
              {isTerminal
                ? evidenceOnly ? '资料已保留' : evidenceFreeBrief ? `${outputLabel}已生成，但未找到资料` : finalStatus === 'succeeded' ? reportNeedsReview ? `${outputLabel}已生成` : '研究完成' : '研究已结束'
                : hasReaderReport ? `${outputLabel}已生成` : '正在建立证据链'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground" aria-live="polite" aria-atomic="true">
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
            </p>
          </div>
          {showTerminalOutcome ? (
            <div className="shrink-0 text-right">
              <div className="font-mono text-lg font-semibold text-muted-foreground">{terminalProgressLabel}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {terminalProgressCaption}
              </div>
            </div>
          ) : null}
        </div>
        {showTerminalOutcome ? (
          <p className="mt-4 text-xs text-muted-foreground" role="status">
            {terminalProgressLabel} · {terminalProgressCaption}
          </p>
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
      </div>

      {/* 完成态首先呈现用户来这里要读懂的结果；过程和来源仍保留在下方供核查。 */}
      {(isTerminal || hasReaderReport) && s.artifact?.content && (hasReaderReport || hasEvidenceSnapshot) ? (
          <section className="border-t border-border bg-background/40 px-5 py-6" aria-label={evidenceOnly ? '本轮资料快照' : !isTerminal ? `${outputLabel}（依据整理中）` : `${outputLabel}结果`}>
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
            <div>
              <p className={cn('text-[11px] font-semibold uppercase tracking-wide', evidenceOnly || finalStatus === 'partial' ? 'text-status-partial-fg' : 'text-primary')}>
                {evidenceOnly ? '资料摘要' : !isTerminal ? `${outputLabel} · 依据整理中` : finalStatus === 'partial' ? `阶段性${outputLabel}` : '研究产物'}
              </p>
              <h3 className="mt-1 text-lg font-semibold">{s.artifact.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {s.sources.length > 0
                ? `${s.sources.length < s.savedSourcesCount ? `已保存 ${s.savedSourcesCount} 条，当前展示最近 ${s.sources.length} 条` : `${s.savedSourcesCount} 条资料`} · ${capturedSources} 条有可核对正文 · 第 ${s.artifact.version} 版 · 可打开来源并核对原文`
                  : s.sourcesCount > 0
                    ? `运行时发现 ${s.sourcesCount} 条候选网页，但没有保存可核对正文 · 第 ${s.artifact.version} 版`
                    : `本轮未保存可核对资料 · 第 ${s.artifact.version} 版`}
              </p>
                {!isTerminal && hasReaderReport ? (
                  <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">
                    这份研究稿已基于本轮实际抓取的证据生成，可以先阅读；关键结论确认完成后，页面会补充最终状态。
                  </p>
                ) : evidenceOnly ? (
                  <p className="mt-2 max-w-2xl text-xs leading-5 text-status-partial-fg">
                    本轮只保存了实际抓取的来源摘录，没有生成可交付的研究结论。请把它当作下一轮研究输入，不要当成已验证报告。
                  </p>
                ) : finalStatus === 'partial' ? (
                <p className="mt-2 max-w-2xl text-xs leading-5 text-status-partial-fg">
                  研究稿已在关键结论确认完成前保存。它可以阅读和追问，但关键判断请先核对下方来源，或重新运行以完成确认。
                </p>
              ) : null}
            </div>
            {finalStatus === 'succeeded' && !isBrief && s.draftResearchId ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/researches/${s.draftResearchId}/edit`}>
                  <PenLine className="size-3.5" />
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
                <Library className="size-3.5" />
                查看研究库
              </Link>
            </Button>
          </div>
          <div className="mx-auto max-w-4xl">
            <ResearchOutputViews
              content={s.artifact.content}
              artifactType={evidenceOnly ? 'markdown' : s.artifact.type === 'slides' ? 'slides' : 'markdown'}
              sources={s.sources}
              evidenceOnly={evidenceOnly}
              presentationType={s.reportType === 'web_brief' ? 'web' : 'standard'}
              reviewStatus={s.review?.status}
              showQualityStatus={false}
            />
          </div>
        </section>
      ) : null}

      {isTerminal && !!s.artifact?.content && (hasReaderReport || hasEvidenceSnapshot) ? (
        <div className="border-t border-border px-5 pb-5">
          <ResearchChatPanel
            conversation={conversationQuery.data ?? null}
            canAsk={hasReaderReport || hasEvidenceSnapshot}
            note={evidenceOnly
              ? '当前只有可核对资料快照；追问只会基于这批资料回答，不会把它自动变成研究结论。'
              : finalStatus === 'partial' ? '可基于阶段性研究稿继续追问；如需把它作为正式依据，请先完成关键结论确认。' : '回答会基于上方报告和本次研究上下文。'}
            reportId={s.draftResearchId}
            reportContent={s.artifact?.content ?? null}
            rawReportContent={s.artifact?.rawContent ?? s.artifact?.content ?? null}
          />
        </div>
      ) : null}

      <div className="p-5">
        {!isBrief && !evidenceOnly && showResultState ? (
          <section id="quality-check" className="mb-5" aria-label="使用建议">
            <ReviewPanel review={s.review} reviewRun={s.reviewRun} researchSufficiency={researchSufficiency} draftResearchId={s.draftResearchId} />
          </section>
        ) : null}
        <details className="rounded-md border border-border/80 bg-muted/[0.12]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
            <span>查看研究详情</span>
            <span className="text-xs font-normal text-muted-foreground">
              <span className="hidden sm:inline">研究过程 · 资料 · 证据缺口</span>
              <span className="sm:hidden">过程与资料</span>
            </span>
          </summary>
          <div className="border-t border-border/70 px-4 pb-4 pt-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">按时间顺序记录研究如何得出结论。</p>
              </div>
              {!isTerminal ? (
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="xs" onClick={() => void cancelJob()} disabled={cancelling}>
                    <XCircle className={cn('size-3', cancelling && 'animate-pulse')} />
                    {cancelling ? '取消中…' : '取消调研'}
                  </Button>
                </div>
              ) : null}
            </div>
            {cancelError ? <p role="alert" className="mt-2 text-xs text-destructive">{cancelError}</p> : null}
            <div className="relative ml-1 border-l border-border pl-6">
              {STEPS.map((step, idx) => {
                const state = stepState(s, idx);
                const displayStep = isBrief && step.key === 'write'
                  ? { ...step, label: '生成摘要', desc: '生成轻量摘要，不创建研究稿' }
                  : step;
                return (
                  <TimelineStep key={step.key} step={displayStep} state={state} count={countForStep(s, step.key, state)} />
                );
              })}
            </div>
            <EvidencePanel
              sources={s.sources ?? []}
              discoveredTotal={s.sourcesCount}
              capturedTotal={capturedSources}
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
          </div>
        </details>
        {!isBrief && !evidenceOnly && isTerminal && !['queued', 'reviewing'].includes(s.reviewRun?.executionStatus ?? s.review?.status ?? s.review?.phase ?? '') && !(s.reviewRun?.claims?.length || s.review?.claims?.length) ? <EvidenceLedger review={s.review} sources={s.sources} /> : null}
      </div>

      {/* 运行细节 —— 默认折叠；步骤状态已显示在研究过程内 */}
      <JobStatusDisclosure s={s} elapsed={elapsed} />

      {finalStatus === 'partial' ? (
        <div
          role="alert"
          className="border-t border-border bg-status-partial-bg p-4 text-sm text-status-partial-fg"
        >
            <strong className="font-medium">{hasReaderReport ? '阶段性研究稿可用' : '已保留研究资料'}</strong>
          {s.errorCode ? <span className="ml-2">{friendlyMessage({ code: s.errorCode }, '调研在生成结果前中断')}</span> : null}
          <p className="mt-1.5 text-xs opacity-90">
            {hasReaderReport
              ? '任务在结果确认完成前达到时间上限；阶段性研究稿和已抓取资料已保留，可继续阅读、追问或重新运行。'
              : '任务在生成研究结论前结束；已生成资料快照，可先核对原文或基于这批资料追问。本轮没有可编辑研究稿。'}
          </p>
          {s.errorCode ? <p className="mt-1 text-[11px] opacity-75">错误码：{s.errorCode}</p> : null}
        </div>
      ) : s.errorCode ? (
        <div
          role="alert"
          className="border-t border-border bg-status-failed-bg p-4 text-sm text-status-failed-fg"
        >
          <strong className="font-medium">{friendlyMessage({ code: s.errorCode }, '调研失败')}</strong>
          <span className="ml-2 text-xs opacity-80">错误码：{s.errorCode}</span>
          {s.errorMessage ? <p className="mt-1.5 text-xs opacity-90">{s.errorMessage}</p> : null}
          {s.errorDetails ? (
            <details className="mt-2 rounded border border-border/70 bg-muted/40 p-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">查看错误详情</summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono">{JSON.stringify(s.errorDetails, null, 2)}</pre>
            </details>
          ) : null}
        </div>
      ) : null}

      {isTerminal ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
          <div className="text-sm">
            {evidenceOnly ? (
              <span className="text-status-partial-fg">已保留可核对资料快照；尚未生成研究结论。</span>
            ) : finalStatus === 'succeeded' ? (
              <span className="text-status-succeeded-fg">
                {evidenceFreeBrief
                  ? '快速判断已生成，但本轮没有找到可核对资料；未创建调研草稿。'
                  : isBrief ? '快速判断已生成，未创建调研草稿。' : s.reportType === 'slides' ? 'Slides 提纲已生成，可继续编辑或追问。' : s.reportType === 'web_brief' ? '网页简报已生成，可直接阅读、分享或继续追问。' : '研究稿已完成，私有草稿仅你本人可见。'}
              </span>
            ) : finalStatus === 'partial' ? (
              <span className="text-status-partial-fg">
                {hasReaderReport
                  ? '阶段性研究稿已保存，关键结论确认未完成。'
                  : '任务已部分完成，已保留抓取资料但未生成可交付结论。'}
              </span>
            ) : finalStatus === 'failed' ? (
              <span className="text-status-failed-fg">任务失败，可以回到提交页重新发起。</span>
            ) : (
              <span className="text-muted-foreground">任务已撤回。</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/ai-research">重新调研</Link>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
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
  failed,
  running,
  reportLength,
}: {
  sources: AiJobStatus['sources'];
  discoveredTotal: number;
  capturedTotal: number;
  failed: number;
  running: boolean;
  reportLength: 'brief' | 'standard' | 'deep';
}) {
  // 运行中需要实时看到新资料；完成后先给出数量，把详细清单留给主动核查的用户。
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="mt-5 overflow-hidden rounded-md border border-border bg-muted/20" aria-label="资料与证据">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/40"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
          <span className="flex min-w-0 items-center gap-2">
            <Radar className="size-4 text-primary" />
            <span className="text-sm font-semibold">资料与证据</span>
          </span>
          <span className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          <span className="truncate">
            检索线索 {discoveredTotal} · 可引用证据 {capturedTotal}
            {failed > 0 ? ` · ${failed} 条未取到正文` : ''}
          </span>
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-border px-3 py-3">
          {sources.length === 0 ? (
            <p className="px-1 py-3 text-xs text-muted-foreground">
              {running
                ? reportLength === 'deep'
                  ? '正在并行展开多个研究分支；检索线索会先出现，只有取得可核对正文后才会计入可引用证据。'
                  : '正在寻找第一批可用来源…'
                : discoveredTotal > 0
                  ? `发现 ${discoveredTotal} 条检索线索，但该任务没有保存可引用正文。`
                  : '本次任务没有保存可展示的来源。'}
            </p>
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {sources.map((source) => (
                <li key={source.id} className="min-w-0 rounded-lg border border-border bg-background px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    {source.href ? (
                      <a
                        href={source.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="min-w-0 font-medium text-foreground hover:text-primary hover:underline"
                      >
                        <span className="line-clamp-2">{source.title}</span>
                      </a>
                    ) : (
                      <span className="line-clamp-2 min-w-0 font-medium text-foreground">{source.title}</span>
                    )}
                    {source.href ? <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground" /> : null}
                  </div>
                  {source.snippet ? <p className="mt-1.5 line-clamp-2 text-[11px] leading-5 text-muted-foreground">{cleanEvidenceSnippet(source.snippet, 320)}</p> : null}
                  <div className="mt-2 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <span>{SOURCE_TYPE_LABELS[source.type] ?? source.type}</span>
                    <span aria-hidden>·</span>
                    <span>{stepLabel(source.stepCaptured)}</span>
                    <span aria-hidden>·</span>
                    <span title={source.capturedAt}>抓取 {formatCapturedAt(source.capturedAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
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
    <section className="mt-4 rounded-md border border-primary/25 bg-primary/[0.035] px-4 py-4" aria-label="证据检查点">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">证据检查点</h3>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">{isTerminal ? '本轮已结束' : '可随时纠偏'}</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {isTerminal
              ? '下面把本轮已经收集的证据和仍缺的内容集中呈现，帮助你决定是否需要追问、修订或重新研究。'
              : s.reportLength === 'deep'
                ? `任务会继续按启动时的范围执行；当前已保存 ${sourceCount} 条来源${failed > 0 ? `，其中 ${failed} 条获取失败` : ''}。深度研究会先展开多个角度，再补查证据缺口。`
                : `任务会继续按启动时的范围执行；当前已记录 ${sourceCount} 条来源${failed > 0 ? `，其中 ${failed} 条获取失败` : ''}。你可以继续等待，也可以现在收敛范围。`}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            原始检索设置：{scopeSummary(s.brief?.scope)} · {s.sourcePolicy === 'only_user_sources' ? '仅使用已选资料' : '网页搜索 + 已选资料'} · {sourceProvenanceSummary(s)}
            {targetedEvidenceCount > 0 ? ` · 后续声明补证新增 ${targetedEvidenceCount} 条` : ''}
          </p>
        </div>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border/70 bg-background/70 p-3">
            <h4 className="text-xs font-semibold text-foreground">已抓到的证据</h4>
          <ul className="mt-2 space-y-1.5 text-xs leading-5 text-muted-foreground">
            {findings.map((finding) => <li key={finding} className="flex gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-primary" />{finding}</li>)}
          </ul>
        </div>
        <div className="rounded-lg border border-warning-border/40 bg-warning-bg/20 p-3">
          <h4 className="text-xs font-semibold text-foreground">还缺什么证据</h4>
          <ul className="mt-2 space-y-1.5 text-xs leading-5 text-muted-foreground">
            {gaps.map((gap) => <li key={gap} className="flex gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-warning-fg" />{gap}</li>)}
          </ul>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!isTerminal ? (
          <>
            <span className="text-[11px] text-muted-foreground">任务会按启动时的设置继续运行；离开页面不会停止。</span>
            <Button type="button" size="xs" variant="outline" onClick={async () => { const cancelled = await onCancel(); if (cancelled) router.push('/ai-research'); }} disabled={cancelling}>
              {cancelling ? '结束中…' : '结束并调整设置'}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => void onCancel()} disabled={cancelling}>
              {cancelling ? '结束中…' : '结束并保留已抓取资料'}
            </Button>
          </>
          ) : s.deliverableStatus === 'evidence_only' ? (
          <>
            <Link href="#research-chat" className="text-xs font-medium text-primary hover:underline">基于这批资料继续追问</Link>
            <Button type="button" size="xs" variant="outline" onClick={() => router.push('/ai-research')}>
              重新研究并调整设置
            </Button>
          </>
        ) : canRestart ? (
          <Button type="button" size="xs" variant="outline" onClick={() => router.push('/ai-research')}>
            重新开始并调整设置
          </Button>
        ) : (
          <Link href="#research-chat" className="text-xs font-medium text-primary hover:underline">继续追问这份研究</Link>
        )}
      </div>
    </section>
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
    gaps.push(`研究计划缺口：还没有为${s.researchSufficiency.missing.join('、')}保存可核对资料。`);
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
      {researchSufficiency?.status === 'insufficient' ? (
        <div className="mb-3 rounded-md border border-warning-border/70 bg-warning-bg/[0.22] px-3 py-2.5 text-xs leading-5 text-warning-fg">
          <p className="font-medium">资料范围还有缺口</p>
          <p className="mt-0.5">当前结果还没有覆盖：{researchSufficiency.missing.join('、')}。如果要做完整比较，请补充这些资料。</p>
          <Link href="/ai-research" className="mt-1 inline-flex font-medium text-primary hover:underline">补充资料并重新研究</Link>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">使用建议</h3>
          <p className="text-xs text-muted-foreground">先看这份结果是否适合直接参考，需要时再查看依据。</p>
        </div>
        <div className="flex items-center gap-2">
          {canReReview ? (
            <Button type="button" variant="default" size="sm" onClick={() => void reReview()} disabled={reReviewing}>
              <RotateCw className={cn('size-3.5', reReviewing && 'animate-spin')} />
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
        </div>
      </div>
      {reviewStale ? (
        <div className="mt-2 rounded-md border border-warning-border/60 bg-warning-bg/40 px-3 py-2 text-xs leading-5 text-warning-fg">
          <p className="font-medium">研究内容已经变更，需要重新整理依据。</p>
          <p className="mt-0.5">上一轮依据仍保留在历史记录中，但不能用于当前版本。</p>
        </div>
      ) : review ? (
        reviewQueued || reviewRunning ? (
          <div className="mt-2 rounded-md border border-primary/20 bg-primary/[0.04] px-3 py-2 text-xs leading-5 text-muted-foreground">
            <p className="font-medium text-foreground">结果正在整理</p>
            <p className="mt-0.5">你可以继续阅读或追问；完成后这里会自动更新。</p>
          </div>
        ) : reviewUnavailable ? (
          <div className="mt-2 rounded-md border border-warning-border/60 bg-warning-bg/40 px-3 py-2 text-xs leading-5 text-warning-fg">
            <p className="font-medium">暂时无法确认</p>
            <p className="mt-0.5">这不代表结论错误；当前版本只是还没有得到完整的依据确认。</p>
          </div>
        ) : null
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">检查结果还没有生成；你可以先阅读研究稿，完成后这里会自动显示需要注意的结论。</p>
      )}
      {!reviewQueued && !reviewRunning && !reviewUnavailable && !reviewStale && reviewRun?.executionStatus === 'completed' ? (
        <div className={cn(
          'mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2.5 text-xs',
          publicationGate.status === 'blocked'
            ? 'border-status-failed-border/50 bg-status-failed-bg/30'
            : pendingClaims.length > 0 || publicationGate.status !== 'clear'
              ? 'border-warning-border/50 bg-warning-bg/30'
              : 'border-status-succeeded-border/50 bg-status-succeeded-bg/30',
        )} aria-label="结果摘要">
          <div>
            <span className="font-medium text-foreground">{displayLabel}</span>
            <span className="ml-2 text-muted-foreground">{summary}</span>
          </div>
        </div>
      ) : null}
      {reReviewError ? (
        <p role="alert" className="mt-2 text-xs text-destructive">{reReviewError}</p>
      ) : null}
      {decisionError ? (
        <p role="alert" className="mt-2 text-xs text-destructive">{decisionError}</p>
      ) : null}
      {evidenceTaskError ? (
        <p role="alert" className="mt-2 text-xs text-destructive">{evidenceTaskError}</p>
      ) : null}
      <details id="quality-check-evidence" className="mt-3 rounded border border-border/70 bg-muted/20 p-2 text-xs">
        <summary className="cursor-pointer font-medium text-foreground">
          {pendingClaims.length > 0 ? `查看并处理 ${pendingClaims.length} 条待确认结论` : '查看结论依据'}
        </summary>
        <div className="mt-2 space-y-2 rounded border border-border/70 bg-background/50 p-3 text-[11px] leading-5 text-muted-foreground">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <span>关键结论 {factualClaimCount}</span>
            <span>有直接依据 {claimCounts.supported}</span>
            <span>需要确认 {claimCounts.unverified}</span>
            <span>来源不一致 {claimCounts.contradicted}</span>
          </div>
          {citationPendingCount > 0 ? <p>有 {citationPendingCount} 条引用关系还没有完成确认。</p> : null}
          {evidenceBindingRepairedCount > 0 ? <p>已从保存的资料中找到 {evidenceBindingRepairedCount} 条可对照摘录；这不等同于结论已经成立。</p> : null}
          {claims.length > 0 ? (
            <div className="divide-y divide-border/70 rounded border border-border/70 bg-background">
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
                />
              ))}
            </div>
          ) : <p>本轮没有保存逐条声明；请直接查看研究资料中的原文。</p>}
          {pendingClaims.length > 0 ? (
            <p className="border-t border-border/70 pt-2">如果修改正文，相关结果会随当前版本重新检查。</p>
          ) : null}
        </div>
      </details>
      <Dialog
        open={Boolean(decisionRequest)}
        onOpenChange={(open) => {
          if (!open) {
            setDecisionRequest(null);
            setDecisionReason('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decisionRequest?.action === 'challenge_support' ? '质疑这条证据关系' : '确认保留这条待验证项'}
            </DialogTitle>
            <DialogDescription>
              {decisionRequest?.action === 'challenge_support'
                ? '系统会用当前已保存资料重新核对，正文不会改变。完成后会更新依据状态。'
                : '这不会修改正文。确认后可以发布，但读者会看到这条结论仍保留为待确认项；后续修改正文后，这个决定会随版本一起失效。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-foreground">
              {decisionRequest?.claim.claim}
            </div>
            <label className="grid gap-1.5 text-xs font-medium" htmlFor="review-decision-reason">
              处理依据 <span className="font-normal text-muted-foreground">（必填）</span>
              <Textarea
                id="review-decision-reason"
                value={decisionReason}
                onChange={(event) => setDecisionReason(event.target.value)}
                placeholder={decisionRequest?.action === 'challenge_support'
                  ? '例如：摘录描述的是背景，不足以支持这条结论。'
                  : '例如：这是低风险开放问题，当前没有足够资料，但我会在风险项中保留说明。'}
                rows={4}
                className="resize-y text-sm font-normal"
              />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { setDecisionRequest(null); setDecisionReason(''); }}>
              取消
            </Button>
            <Button type="button" onClick={() => void confirmDecision()} disabled={!decisionReason.trim() || decisionBusy !== null}>
              {decisionBusy ? '处理中…' : decisionRequest?.action === 'challenge_support' ? '重新核对证据' : '保存处理决定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
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
  const statusClass = status === '有直接依据' || status === '已建立引用'
    ? 'bg-status-succeeded-bg text-status-succeeded-fg'
    : status === '来源不一致'
      ? 'bg-status-failed-bg text-status-failed-fg'
      : 'bg-warning-bg text-warning-fg';
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
    <article className="px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h5 className="min-w-0 flex-1 text-xs font-semibold leading-5 text-foreground">{claimText || '未命名声明'}</h5>
        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', statusClass)}>{status}</span>
      </div>
      {claim.reason ? <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">{citationRelationship && reviewUnavailable ? '已建立来源回链，但本轮没有完成确认。' : claim.evidence?.resolver === 'captured-source-reconciler' ? '找到可对照资料，但还不能确认它支持这句话。' : claim.reason.includes('审核结果没有提供') ? '当前没有能直接对照的资料。' : claim.reason}</p> : null}
      {judgmentStatus !== 'settled' ? (
        <p className="mt-1.5 text-[11px] leading-5 text-warning-fg">
          {judgmentStatus === 'disputed'
            ? '两次独立核对给出了不同判断，系统不会替你判定真伪。'
            : '这条声明已经被识别，但还没有形成可用的最终判断。'}
        </p>
      ) : null}
      <div className="mt-2 rounded border border-border/70 bg-background/70 px-2.5 py-2 text-[11px] leading-5">
        <span className="font-medium text-foreground">可对照的原文：</span>
        <span className="text-muted-foreground">{claim.evidence?.excerpt || '没有保存可核对摘录'}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {claim.evidence?.source_url ? (
          <a className="inline-flex items-center gap-1 text-primary hover:underline" href={claim.evidence.source_url} target="_blank" rel="noreferrer noopener">
            打开来源 <ExternalLink className="size-3" />
          </a>
        ) : <span className="text-muted-foreground">没有可打开的来源</span>}
        {claim.evidence?.observed_at ? <span className="text-muted-foreground">观察时间：{claim.evidence.observed_at}</span> : null}
      </div>
      {needsAction ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
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
              <Link href={editHref}><PenLine className="size-3" />定位正文</Link>
            </Button>
          ) : null}
          {canAcceptUncertainty ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => onDecision?.(claim, 'accept_uncertainty')} disabled={decisionBusy}>
              {decisionBusy ? '保存中…' : '暂时保留'}
            </Button>
          ) : null}
          {nextAction === 'edit_claim' ? (
            <span className="text-[10px] text-status-failed-fg">来源不一致；请修改表述或删除后重新检查</span>
          ) : risk === 'high' ? (
            <span className="text-[10px] text-status-failed-fg">高风险项必须修改或补足证据</span>
          ) : status === '来源不一致' ? (
            <span className="text-[10px] text-status-failed-fg">来源不一致，不能直接接受；请修改表述或删除</span>
          ) : (
            <span className="text-[10px] text-muted-foreground">修改正文后需要重新确认</span>
          )}
        </div>
      ) : null}
      {status === '有直接依据' && !reviewUnavailable && onChallenge ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => onChallenge(claim, 'challenge_support')}
            disabled={decisionBusy}
          >
            {decisionBusy ? '排队中…' : '证据不匹配？重新核对'}
          </Button>
          <span className="text-[10px] text-muted-foreground">如果这条依据不对，可以要求重新确认。</span>
        </div>
      ) : null}
      {evidenceTask ? (
        <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
          {evidenceTask.status === 'queued' || evidenceTask.status === 'researching'
            ? '正在针对这条声明寻找新的直接来源；原研究稿暂不改变。'
            : evidenceTask.status === 'evidence_ready' || evidenceTask.status === 'review_queued'
              ? `已找到 ${evidenceTask.sourceCount ?? 0} 条新资料，正在用新资料重新确认当前版本。`
              : evidenceTask.status === 'completed'
                ? '定向补证和新一轮依据整理已完成，请查看更新后的证据关系。'
                : '定向补证未完成，原研究稿没有改变。'}
        </p>
      ) : null}
    </article>
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
    <section className="mt-5 overflow-hidden rounded-md border border-primary/20 bg-primary/[0.025]" aria-label={ledgerTitle}>
      <div className="border-b border-primary/10 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">{ledgerTitle}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
              {claims.length > 0 && reviewUnavailable
                ? '这里记录报告与来源的对应关系；本轮确认未完成，因此不把任何一条标记为已支持或存在冲突。'
                : claims.length > 0
                ? '逐条查看报告判断、保存的来源摘录和依据状态；有来源地址不代表结论已被支持。'
                : '本轮没有建立“结论—来源”对应关系；下面只列出可供人工核查的已抓取正文，不把来源本身当作已支持结论。'}
            </p>
          </div>
          {claims.length > 0 ? (
            reviewUnavailable ? (
              <span className="rounded-full border border-warning-border/70 bg-warning-bg/60 px-2 py-1 text-[11px] text-warning-fg">
                {citationPending > 0
                  ? `已保留 ${citationPending} 条引用关系`
                  : factualClaimCount > 0
                    ? `${factualClaimCount} 条事实声明待核对`
                    : '语义核验未完成'}
              </span>
            ) : (
              <div className="flex gap-2 text-[11px] tabular-nums">
                <span className="rounded-full bg-status-succeeded-bg px-2 py-1 text-status-succeeded-fg">已支持 {counts.supported}</span>
                <span className="rounded-full bg-warning-bg px-2 py-1 text-warning-fg">需要确认 {counts.unverified}</span>
                <span className="rounded-full bg-status-failed-bg px-2 py-1 text-status-failed-fg">冲突 {counts.contradicted}</span>
              </div>
            )
          ) : null}
        </div>
      </div>
      {claims.length === 0 ? (
        <div className="px-4 py-3">
          <p className="text-xs leading-5 text-muted-foreground">
            这通常表示依据整理超时、不可用，或历史任务没有保存逐条结果。请优先核对报告中的关键判断；“没有记录”不等于所有结论都已被证明。
          </p>
          {inspectableSources.length > 0 ? (
            <ul className="mt-3 grid gap-2 md:grid-cols-2" aria-label="可人工核查的来源">
              {inspectableSources.map((source) => (
                <li key={source.id} className="min-w-0 rounded-md border border-border/70 bg-background/70 px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    {source.href ? (
                      <a className="min-w-0 text-xs font-medium text-foreground hover:text-primary hover:underline" href={source.href} target="_blank" rel="noreferrer noopener">
                        <span className="line-clamp-2">{source.title}</span>
                      </a>
                    ) : (
                      <span className="line-clamp-2 min-w-0 text-xs font-medium text-foreground">{source.title}</span>
                    )}
                    {source.href ? <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">{cleanEvidenceSnippet(source.snippet ?? '', 240)}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                    <span>{SOURCE_TYPE_LABELS[source.type] ?? source.type}</span>
                    <span aria-hidden>·</span>
                    <span>抓取于 {formatCapturedAt(source.capturedAt)}</span>
                    {source.href ? (
                      <a className="inline-flex items-center gap-1 text-primary hover:underline" href={source.href} target="_blank" rel="noreferrer noopener">
                        打开来源 <ExternalLink className="size-3" aria-hidden />
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-md border border-warning-border/50 bg-warning-bg/20 px-3 py-2 text-xs leading-5 text-warning-fg">
              本轮没有保存可核对的原文摘录，只能把报告视为需要确认的草稿。
            </p>
          )}
          {sources.length > inspectableSources.length ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              另有 {sources.length - inspectableSources.length} 条已保存资料可在上方“研究资料”中查看；它们不会自动支撑报告结论。
            </p>
          ) : null}
        </div>
      ) : null}
      {claims.length > 0 ? (
      <details open={!reviewUnavailable} className="border-t border-border/70">
        <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-foreground">
          {reviewUnavailable
            ? `查看资料关系明细 · ${citationCount || claims.length} 条（完成后显示结论关系）`
            : `查看逐条依据 · ${claims.length} 条`}
        </summary>
      <div className="divide-y divide-border/70">
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
          const statusClass = status === '已支持' || status === '已建立引用'
            ? 'bg-status-succeeded-bg text-status-succeeded-fg'
            : status === '存在冲突' ? 'bg-status-failed-bg text-status-failed-fg'
              : status === '非结论内容' ? 'bg-muted text-muted-foreground'
              : 'bg-warning-bg text-warning-fg';
          return (
            <article key={`${claim.claim ?? 'claim'}-${index}`} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h4 className="min-w-0 flex-1 text-sm font-medium">{claim.claim || '未命名声明'}</h4>
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', statusClass)}>{status}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <span className="rounded-full border border-border px-2 py-0.5">{claimKindLabel(claim)}</span>
                <span>{claimKindDescription(claim)}</span>
              </div>
              {claim.reason ? <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{citationRelationship && reviewUnavailable ? '已建立来源回链，尚未完成语义支持判断。' : claim.reason}</p> : null}
              <div className="mt-2 rounded-md border border-border/70 bg-background/70 px-3 py-2 text-xs leading-5">
                <span className="font-medium text-foreground">来源摘录：</span>
                <span className="text-muted-foreground">{claim.evidence?.excerpt || '没有保存原文摘录，因此不能把这条声明称为已支持。'}</span>
              </div>
              {(() => {
                const matchedSource = findEvidenceSource(claim, sources);
                return matchedSource ? (
                  <div className="mt-2 rounded-md border border-primary/15 bg-primary/[0.03] px-3 py-2 text-[11px] leading-5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-foreground">来源：{matchedSource.title}</span>
                      <span className="text-muted-foreground">{SOURCE_TYPE_LABELS[matchedSource.type] ?? matchedSource.type}</span>
                      <span className="text-muted-foreground">抓取于 {formatCapturedAt(matchedSource.capturedAt)}</span>
                    </div>
                    {matchedSource.snippet ? <p className="mt-1 text-muted-foreground">{matchedSource.snippet}</p> : null}
                  </div>
                ) : null;
              })()}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {claim.evidence?.source_url ? (
                  <a className="inline-flex items-center gap-1 text-primary hover:underline" href={claim.evidence.source_url} target="_blank" rel="noreferrer noopener">
                    打开来源 <ExternalLink className="size-3" />
                  </a>
                ) : <span>没有可打开的来源地址</span>}
                {claim.evidence?.observed_at ? <span>观察时间：{claim.evidence.observed_at}</span> : null}
              </div>
            </article>
          );
          })}
      </div>
      </details>
      ) : null}
    </section>
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
  const dotClass = {
    done: 'border-status-succeeded-fg bg-status-succeeded-fg text-white',
    current: 'border-primary bg-primary text-primary-foreground shadow-[0_0_0_4px_hsl(var(--primary)/.12)]',
    attention: 'border-warning-fg bg-warning-fg text-white',
    error: 'border-status-failed-fg bg-status-failed-fg text-white',
    waiting: 'border-border bg-card text-muted-foreground',
  }[state];
  /* 三态 label 让屏幕阅读器读出当前步骤的状态(色弱/单视觉用户也能感知) */
  const stateLabel = { done: '已完成', current: '进行中', attention: '需处理', error: '失败', waiting: '等待' }[state];
  return (
    <div className={cn('relative pb-5', last && 'pb-0')}>
      <span
        className={cn('absolute -left-[2.05rem] top-0 grid size-5 place-items-center rounded-full border-2', dotClass)}
        role="img"
        aria-label={`${step.label}:${stateLabel}`}
      >
        <Icon aria-hidden className="size-2.5" />
      </span>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn('text-sm font-medium', state === 'waiting' && 'text-muted-foreground')}>{step.label}</span>
        <span className={cn('text-[11px]', state === 'current' ? 'text-primary' : state === 'attention' ? 'text-warning-fg' : state === 'error' ? 'text-status-failed-fg' : 'text-muted-foreground')}>
          {STEP_LABELS[state]}
        </span>
        {count ? <span className="truncate text-[11px] text-muted-foreground" title={count}>{count}</span> : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground" title={step.desc}>
        {step.desc}
      </p>
    </div>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span className={cn('truncate', mono && 'font-mono tabular-nums')}>{value}</span>
    </div>
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

  // dl 列表:每个数据单独 dt/dd + title,屏幕阅读器和鼠标 hover 都能看到完整字段
  const summaryParts = [
    { term: '已耗时', value: elapsed },
    { term: '已保存来源', value: String(savedSourcesCount) },
    { term: '运行时来源', value: `${s.partialSourcesCount}/${s.sourcesCount}` },
    ...(completed
      ? [{ term: '任务状态', value: '已完成' }]
      : s.currentStep
        ? [{ term: '当前步骤', value: stepLabel(s.currentStep) }]
        : []),
    ...(s.costCents > 0 ? [{ term: '成本', value: `$${(s.costCents / 100).toFixed(2)}` }] : []),
  ];

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="job-status-details"
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-4 py-2 text-left transition-colors duration-150 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
          {open ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
          更多信息
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">{summary}</span>
      </button>
      {open && (
        <div
          id="job-status-details"
          role="region"
          aria-label="更多信息"
          className="grid gap-x-4 gap-y-2 border-t border-border bg-muted/40 px-4 py-3 text-xs sm:grid-cols-2 lg:grid-cols-3"
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
        </div>
      )}
    </div>
  );
}
