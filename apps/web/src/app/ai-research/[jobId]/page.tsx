'use client';

import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Lightbulb,
  ListChecks,
  PenLine,
  Radar,
  RefreshCw,
  RotateCw,
  ShieldCheck,
} from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { SectionCard } from '@/components/domain/SectionCard';
import {
  progressPct as progressPctShared,
  stepIndex as stepIndexShared,
  terminalCaption,
} from '@/lib/ai-progress';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { retryOnceAi } from '@/lib/errors/friendly';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { PageHeader } from '@/components/domain/PageHeader';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { reviewDisplayLabel, reviewDisplayStatus } from '@/lib/ai-review-ui';

interface AiJobStatus {
  jobId: string;
  status: string;
  finalStatus: string | null;
  currentStep: string | null;
  sourcesCount: number;
  topic: string | null;
  partialSourcesCount: number;
  failedSourcesCount: number;
  errorStage: string | null;
  tokenInputTotal: number;
  tokenOutputTotal: number;
  costCents: number;
  draftResearchId: string | null;
  reportType: string | null;
  outputText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: Record<string, unknown> | null;
  startedAt: string | null;
  createdAt: string | null;
  completedAt: string | null;
  review: ReviewDetails | null;
}

interface ReviewClaim {
  claim?: string;
  risk?: string;
  verdict?: string;
  reason?: string | null;
  correction?: string | null;
  evidence?: {
    source_url?: string | null;
    excerpt?: string | null;
    observed_at?: string | null;
  } | null;
}

interface ReviewDetails {
  phase?: 'not_started' | 'reviewing' | 'completed';
  status?: string;
  attempts?: number;
  corrected_count?: number;
  unverified_count?: number;
  contradicted_count?: number;
  claims?: ReviewClaim[];
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'partial']);
const STEPS = [
  { key: 'plan', label: '规划研究问题', desc: '拆分背景、约束和验证方向', icon: ListChecks },
  { key: 'search', label: '检索与抓取', desc: '优先处理指定资料，再补充外部来源', icon: Radar },
  { key: 'compress', label: '压缩证据', desc: '合并相似结论并保留来源链路', icon: FileText },
  { key: 'analyze', label: '分析与对比', desc: '形成可执行的取舍和风险判断', icon: Lightbulb },
  { key: 'write', label: '写作草稿', desc: '生成可编辑的团队私有草稿', icon: PenLine },
] as const;

const REVIEW_STEP = {
  key: 'review',
  label: '事实审核',
  desc: '核验高风险事实、引用和来源冲突',
  icon: ShieldCheck,
} as const;

type ProcessStep = (typeof STEPS)[number] | typeof REVIEW_STEP;

type StepState = 'done' | 'current' | 'error' | 'waiting';

/**
 * AI 调研任务状态页。
 *
 * 验收 4：每 5s 轮询 /api/ai-research/[jobId]；终态自动停止。
 */
export default function AiJobStatusPage() {
  const params = useParams<{ jobId: string }>();
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
      // 终态停止轮询
      if (s.finalStatus && TERMINAL.has(s.finalStatus)) return false;
      // queued / running 持续 5s 轮询
      return 5_000;
    },
    refetchIntervalInBackground: false,
  });

  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title={q.isError ? '无法加载调研' : q.data?.finalStatus && TERMINAL.has(q.data.finalStatus) ? '调研结果' : '调研进行中'}
        description={
          q.data
            ? `${q.data.reportType === 'summary_brief' ? '轻量摘要' : '研究报告'} · ${q.data.topic ?? '本次调研'}`
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
              <Link href="/ai-research#research-history">查看调研历史</Link>
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

      <div className="mt-4">
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
  const finalStatus = s.finalStatus;
  const isTerminal = !!(finalStatus && TERMINAL.has(finalStatus));

  // 实时计时 —— 终态自动停止,避免后台 1Hz tick 浪费。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (isTerminal) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isTerminal]);

  const pct = progressPctShared(s);
  const elapsed = formatElapsed(s, now);
  const statusLabel = jobStatusLabel(s);
  const isBrief = s.reportType === 'summary_brief';
  const reviewInProgress = s.review?.phase === 'reviewing';
  const reviewCompleted = s.review?.phase === 'completed';

  // 审核阶段(reviewing / completed)优先覆盖 currentStep,避免步骤计数仍指 write。
  const effectiveStep =
    reviewInProgress || reviewCompleted
      ? 'review'
      : (s.currentStep ?? s.errorStage ?? null);
  const activeIdx = stepIndexShared(effectiveStep);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-4">
        <div className="min-w-0">
          <p className="mb-2 text-xs font-medium text-muted-foreground">执行状态</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {s.review?.status ? (
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 font-medium',
                  s.review.status === 'blocked'
                    ? 'bg-status-failed-bg text-status-failed-fg'
                    : s.review.status === 'passed'
                      ? 'bg-status-succeeded-bg text-status-succeeded-fg'
                      : 'bg-status-partial-bg text-status-partial-fg',
                )}
              >
                {statusLabel}
              </span>
            ) : (
              <StatusBadge kind="job" value={statusLabel} label={statusLabel} />
            )}
            {reviewInProgress || reviewCompleted ? (
              <span className="font-mono">步骤 事实审核 ({isBrief ? '5/5' : '6/6'})</span>
            ) : activeIdx >= 0 ? (
              <span className="font-mono">
                步骤 {STEPS[activeIdx].label} ({activeIdx + 1}/{STEPS.length})
              </span>
            ) : null}
            <span>已耗时 {elapsed}</span>
            {!isTerminal ? (
              <span>{isBrief ? '完成后在本页显示摘要' : '完成后可打开私有草稿'}</span>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-3xl font-bold leading-none tabular-nums text-primary">
            {pct}%
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{terminalCaption(s)}</div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="border-b border-border px-4 pb-4">
        <Progress value={Math.min(100, Math.max(0, pct))} />
      </div>

      <div className="space-y-4 p-4">
        <SectionCard
          tone="muted"
          title="调研流程"
          icon={ListChecks}
          actions={
            <span className="font-mono text-[11px] text-muted-foreground">
              {isBrief ? '5 个步骤' : '6 个步骤'}
            </span>
          }
          bodyClassName="space-y-3"
        >
          <p className="text-xs text-muted-foreground">
            {isBrief ? '轻量摘要在写作后直接返回结果。' : '报告生成完成后，自动进入事实审核。'}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {STEPS.map((step, idx) => (
              <StepCard
                key={step.key}
                step={step}
                state={stepState(s, idx)}
                count={countForStep(s, step.key)}
              />
            ))}
            {!isBrief ? (
              <StepCard
                step={REVIEW_STEP}
                state={reviewStepState(s)}
                count={reviewStepCount(s.review)}
              />
            ) : null}
          </div>
          {!isBrief ? (
            <div className="border-t border-border pt-3">
              <ReviewPanel review={s.review} draftResearchId={s.draftResearchId} />
            </div>
          ) : null}
        </SectionCard>
      </div>

      {/* 诊断详情 —— 默认折叠；步骤状态已显示在流程卡片内 */}
      <JobStatusDisclosure s={s} elapsed={elapsed} />

      {finalStatus === 'partial' ? (
        <div
          role="alert"
          className="border-t border-border bg-status-partial-bg p-4 text-sm text-status-partial-fg"
        >
          <strong className="font-medium">部分结果可用</strong>
          {s.errorCode ? <span className="ml-2 font-mono text-xs">{s.errorCode}</span> : null}
          <p className="mt-1.5 text-xs opacity-90">
            任务以部分完成状态结束：已抓取的资料会保留，但不会生成可发布的草稿；重新尝试会创建一条新的调研任务。
          </p>
        </div>
      ) : s.errorCode ? (
        <div
          role="alert"
          className="border-t border-border bg-status-failed-bg p-4 text-sm text-status-failed-fg"
        >
          <strong className="font-mono font-medium">{s.errorCode}</strong>
          {s.errorMessage ? <span className="ml-2">{s.errorMessage}</span> : null}
          {s.errorDetails ? (
            <details className="mt-2 rounded border border-border/70 bg-muted/40 p-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">查看诊断详情</summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono">{JSON.stringify(s.errorDetails, null, 2)}</pre>
            </details>
          ) : null}
        </div>
      ) : null}

      {finalStatus === 'succeeded' && isBrief && s.outputText ? (
        <section className="border-t border-border p-4" aria-label="轻量摘要结果">
          <h3 className="mb-3 text-sm font-semibold">轻量摘要</h3>
          <MarkdownPreview source={s.outputText} />
        </section>
      ) : null}

      {isTerminal ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
          <div className="text-sm">
            {finalStatus === 'succeeded' && s.review?.status === 'blocked' ? (
              <span className="text-status-failed-fg">报告已生成，但事实审核发现冲突，当前不可发布。</span>
            ) : finalStatus === 'succeeded' && s.review?.status === 'review_unavailable' ? (
              <span className="text-status-partial-fg">报告已生成，事实审核未完成，可重跑审核。</span>
            ) : finalStatus === 'succeeded' ? (
              <span className="text-status-succeeded-fg">
                {isBrief ? '轻量摘要已生成，未创建调研草稿。' : '调研完成，私有草稿仅你本人可见。'}
              </span>
            ) : finalStatus === 'partial' ? (
              <span className="text-status-partial-fg">任务已部分完成，已保留抓取资料但未生成草稿。</span>
            ) : finalStatus === 'failed' ? (
              <span className="text-status-failed-fg">任务失败，可以回到提交页重新发起。</span>
            ) : (
              <span className="text-muted-foreground">任务已撤回。</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {finalStatus === 'succeeded' && s.draftResearchId ? (
              <Button asChild size="sm">
                <Link href={`/researches/${s.draftResearchId}/edit`}>
                  <ExternalLink />
                  打开私有草稿
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline" size="sm">
              <Link href="/ai-research">重新调研</Link>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReviewPanel({
  review,
  draftResearchId,
}: {
  review: ReviewDetails | null;
  draftResearchId?: string | null;
}) {
  const params = useParams<{ jobId: string }>();
  const claims = Array.isArray(review?.claims) ? review.claims : [];
  const displayStatus = reviewDisplayStatus(review);
  const statusClass = displayStatus === 'passed'
    ? 'text-status-succeeded-fg'
    : displayStatus === 'blocked'
      ? 'text-status-failed-fg'
      : 'text-status-partial-fg';

  const queryClient = useQueryClient();
  const [reReviewing, setReReviewing] = useState(false);
  const [reReviewError, setReReviewError] = useState<string | null>(null);

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
        const err = await toApiHttpError(r, '重跑审核失败');
        throw err;
      }
      const updated = (await r.json()) as {
        status?: string;
        claims?: unknown[];
        attempts?: number;
        summary?: { corrected_count?: number; unverified_count?: number; contradicted_count?: number };
        reviewedAt?: string | null;
      };
      // 更新 job 查询缓存,让头部 badge / 审核摘要立即刷新。
      queryClient.setQueryData<AiJobStatus>(['ai-job', params.jobId], (old) => {
        if (!old) return old;
        return {
          ...old,
          review: {
            phase: 'completed',
            status: updated.status ?? 'review_unavailable',
            attempts: updated.attempts ?? (old.review?.attempts ?? 0),
            corrected_count: updated.summary?.corrected_count ?? 0,
            unverified_count: updated.summary?.unverified_count ?? 0,
            contradicted_count: updated.summary?.contradicted_count ?? 0,
            claims: (updated.claims ?? []) as ReviewClaim[],
          },
        };
      });
    } catch (e) {
      setReReviewError(e instanceof Error ? e.message : '重跑审核失败，请稍后再试。');
    } finally {
      setReReviewing(false);
    }
  }

  const canReReview = !reReviewing && displayStatus !== 'passed' && !!draftResearchId;

  return (
    <section aria-label="事实审核阶段">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">审核摘要</h3>
          <p className="text-xs text-muted-foreground">只在发现风险时展开具体声明。</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', statusClass)}>{reviewDisplayLabel(review)}</span>
          {canReReview ? (
            <Button type="button" variant="outline" size="xs" onClick={() => void reReview()} disabled={reReviewing}>
              <RotateCw className={cn('size-3', reReviewing && 'animate-spin')} />
              {reReviewing ? '重跑中…' : '重跑审核'}
            </Button>
          ) : null}
        </div>
      </div>
      {review ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>审核轮次 {review.attempts ?? 0}/2</span>
          <span>自动修正 {review.corrected_count ?? 0}</span>
          <span>未核验 {review.unverified_count ?? 0}</span>
          <span>冲突 {review.contradicted_count ?? 0}</span>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">报告生成后自动开始，不会替代 Generator 重写整篇报告。</p>
      )}
      {displayStatus === 'blocked' ? (
        <p role="alert" className="mt-2 text-xs font-medium text-status-failed-fg">存在来源明确反驳的事实，报告不可发布。</p>
      ) : displayStatus === 'review_unavailable' ? (
        <p role="alert" className="mt-2 text-xs text-status-partial-fg">上次审核未完成，点击「重跑审核」重新尝试。</p>
      ) : null}
      {reReviewError ? (
        <p role="alert" className="mt-2 text-xs text-destructive">{reReviewError}</p>
      ) : null}
      {claims.length > 0 ? (
        <details className="mt-3 rounded border border-border/70 bg-muted/20 p-2 text-xs">
          <summary className="cursor-pointer font-medium text-foreground">查看审核明细 · {claims.length} 条</summary>
          <div className="mt-2 space-y-2">
            {claims.map((claim, index) => (
              <div key={`${claim.claim ?? 'claim'}-${index}`} className="rounded border border-border/70 bg-muted/30 p-2">
                <div className="flex flex-wrap gap-2">
                  <span className="font-medium">{claim.claim || '未命名声明'}</span>
                  <span className="text-muted-foreground">{claim.verdict ?? 'unverified'}</span>
                </div>
                {claim.reason ? <p className="mt-1 text-muted-foreground">{claim.reason}</p> : null}
                {claim.correction ? <p className="mt-1">建议修正：{claim.correction}</p> : null}
                {claim.evidence?.source_url ? (
                  <a className="mt-1 inline-flex items-center gap-1 text-primary hover:underline" href={claim.evidence.source_url} target="_blank" rel="noreferrer">
                    查看证据 <ExternalLink className="size-3" />
                  </a>
                ) : null}
                {claim.evidence?.observed_at ? <span className="ml-2 text-muted-foreground">抓取于 {claim.evidence.observed_at}</span> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function stepLabel(step: string | null | undefined): string {
  if (!step) return '—';
  return STEPS.find((item) => item.key === step)?.label ?? '处理中';
}

/** 终态/审核态/排队态的本地化标签;未知 enum 不静默 fallback。 */
function jobStatusLabel(s: AiJobStatus): string {
  const reviewStatus = reviewDisplayStatus(s.review);
  if (reviewStatus === 'blocked') return '审核阻止发布';
  if (reviewStatus === 'needs_revision') return '审核需修订';
  if (reviewStatus === 'review_unavailable') return '审核不可用';

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
  if (s.review?.phase === 'reviewing' || s.review?.phase === 'completed' || s.finalStatus === 'succeeded') return 'done';
  if (s.errorStage === stepKey && (s.finalStatus === 'failed' || s.finalStatus === 'partial')) return 'error';
  if (s.finalStatus === 'cancelled') return activeIdx > idx ? 'done' : 'waiting';
  if (activeIdx > idx) return 'done';
  if (activeIdx === idx) return s.finalStatus === 'failed' || s.finalStatus === 'partial' ? 'error' : 'current';
  return 'waiting';
}

function reviewStepState(s: AiJobStatus): StepState {
  const phase = s.review?.phase;
  const status = reviewDisplayStatus(s.review);
  if (status === 'blocked' || status === 'review_unavailable' || status === 'needs_revision') return 'error';
  if (phase === 'reviewing' || status === 'reviewing') return 'current';
  if (phase === 'completed' || status === 'passed') return 'done';
  return 'waiting';
}

function reviewStepCount(review: ReviewDetails | null): string | null {
  if (!review) return null;
  const status = reviewDisplayLabel(review);
  if (review.phase === 'reviewing') return status;
  if (review.phase === 'completed' || review.status) {
    return `${status} · ${review.contradicted_count ?? 0} 个冲突`;
  }
  return null;
}

function countForStep(s: AiJobStatus, stepKey: string): string | null {
  if (stepKey === 'search' && s.partialSourcesCount > 0) {
    return `${s.partialSourcesCount} 条资料`;
  }
  if (stepKey === 'write' && s.finalStatus === 'succeeded') {
    return s.reportType === 'summary_brief' ? '已生成摘要' : '已生成草稿';
  }
  if (s.errorStage === stepKey && s.errorCode) {
    return s.errorCode;
  }
  return null;
}

/** 步骤状态 → token 化配色。 */
const STEP_CLASSES: Record<StepState, string> = {
  done: 'border-status-succeeded-fg/30 bg-status-succeeded-bg text-status-succeeded-fg',
  current: 'border-status-running-fg/30 bg-status-running-bg text-status-running-fg',
  error: 'border-status-failed-fg/30 bg-status-failed-bg text-status-failed-fg',
  waiting: 'border-border bg-card text-muted-foreground',
};

const STEP_LABELS: Record<StepState, string> = {
  done: '完成',
  current: '当前步骤',
  error: '失败',
  waiting: '等待中',
};

function StepCard({
  step,
  state,
  count,
}: {
  step: ProcessStep;
  state: StepState;
  count: string | null;
}) {
  const Icon = step.icon;
  return (
    <div className={cn('min-w-0 rounded-md border p-2.5', STEP_CLASSES[state])}>
      <div className="flex items-center gap-1.5">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="text-xs font-semibold">{step.label}</span>
      </div>
      <div className="mt-1 text-xs opacity-85">{STEP_LABELS[state]}</div>
      {count ? (
        <div className="mt-1 truncate text-xs" title={count}>
          {count}
        </div>
      ) : null}
      <div className="mt-1 truncate text-[10px] opacity-60" title={step.desc}>
        {step.desc}
      </div>
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
  const summary =
    `${elapsed} · ${s.partialSourcesCount}/${s.sourcesCount} 资料` +
    (s.currentStep ? ` · 当前 ${stepLabel(s.currentStep)}` : '') +
    (s.costCents > 0 ? ` · $${(s.costCents / 100).toFixed(2)}` : '');

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-4 py-2 text-left transition-colors duration-150 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {open ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
          诊断详情
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">{summary}</span>
      </button>
      {open && (
        <div className="grid gap-x-4 gap-y-2 border-t border-border bg-muted/40 px-4 py-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <DetailRow label="正在处理" value={stepLabel(s.currentStep)} />
          <DetailRow label="已抓取总数" value={String(s.sourcesCount)} mono />
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
