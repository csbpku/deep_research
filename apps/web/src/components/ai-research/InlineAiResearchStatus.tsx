'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AlertTriangle, Check, CheckCircle2, Clock3, ExternalLink } from 'lucide-react';
import Link from 'next/link';

import { ArtifactPreview } from '@/components/ai-research/ArtifactPreview';
import { ResearchWebBrief } from '@/components/ai-research/ResearchWebBrief';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { Progress } from '@/components/ui/progress';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toApiHttpError } from '@/lib/errors/api-error';
import { retryOnceAi, friendlyMessage } from '@/lib/errors/friendly';
import { progressPct } from '@/lib/ai-progress';
import { researchUserStatus } from '@/lib/research-user-status';
import { cn } from '@/lib/utils';
import { DeepResearchProgressCard } from '@/components/ai-research/DeepResearchProgressCard';
import type { DeepResearchProgress } from '@/lib/ai-progress';

interface InlineJob {
  jobId: string;
  topic: string | null;
  status: string;
  finalStatus: string | null;
  currentStep: string | null;
  sourcesCount: number;
  partialSourcesCount: number;
  failedSourcesCount: number;
  savedSourcesCount?: number;
  draftResearchId: string | null;
  reportType: string | null;
  reportLength?: 'brief' | 'standard' | 'deep';
  deliverableStatus?: 'report' | 'evidence_only' | 'none';
  researchProgress?: DeepResearchProgress | null;
  outputText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  artifact: {
    type: 'markdown' | 'slides' | 'table' | 'chart';
    title: string;
    content: string | null;
  } | null;
  sources: Array<{
    id: string;
    title: string;
    snippet?: string | null;
    score?: number | null;
    href?: string | null;
    type?: string;
    stepCaptured?: string | null;
    capturedAt?: string;
  }>;
  review?: { status?: string | null; error?: string | null; error_code?: string | null } | null;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'partial']);
const STEP_ORDER = ['plan', 'search', 'compress', 'analyze', 'write'] as const;
const STEP_LABELS: Record<string, string> = {
  plan: '规划问题',
  search: '检索资料',
  compress: '整理证据',
  analyze: '分析对比',
  write: '生成产物',
};

/** 横向阶段 stepper：plan → search → compress → analyze → write。 */
function StepStepper({ currentStep, succeeded }: { currentStep: string | null; succeeded: boolean }) {
  const activeIndex = currentStep ? STEP_ORDER.indexOf(currentStep as (typeof STEP_ORDER)[number]) : -1;
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="调研步骤">
      {STEP_ORDER.map((key, index) => {
        const state = succeeded || (activeIndex >= 0 && index < activeIndex) ? 'done' : index === activeIndex ? 'active' : 'todo';
        return (
          <li key={key} className="flex items-center gap-1.5">
            {index > 0 ? <span className="mx-0.5 h-px w-3 bg-border" aria-hidden /> : null}
            <span
              className={cn(
                'flex size-5 items-center justify-center rounded-full text-[10px] font-medium leading-none',
                state === 'done' && 'bg-status-succeeded-bg text-status-succeeded-fg',
                state === 'active' && 'bg-primary text-primary-foreground',
                state === 'todo' && 'bg-muted text-muted-foreground/70',
              )}
            >
              {state === 'done' ? <Check className="size-3" /> : index + 1}
            </span>
            <span className={cn('text-[11px]', state === 'active' ? 'font-medium text-foreground' : state === 'done' ? 'text-muted-foreground' : 'text-muted-foreground/60')}>
              {STEP_LABELS[key]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function InlineAiResearchStatus({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery<InlineJob>({
    queryKey: ['inline-ai-research', jobId],
    queryFn: async () => {
      const response = await fetch(`/api/ai-research/${jobId}`, { cache: 'no-store' });
      if (!response.ok) throw await toApiHttpError(response, '读取调研状态失败');
      return (await response.json()) as InlineJob;
    },
    retry: retryOnceAi,
    refetchInterval: (data) => {
      const status = data.state.data?.finalStatus ?? data.state.data?.status;
      return status && TERMINAL.has(status) ? false : 5_000;
    },
  });

  const liveStatus = query.data?.finalStatus ?? query.data?.status;
  const liveTerminal = !!liveStatus && TERMINAL.has(liveStatus);

  useEffect(() => {
    if (liveTerminal) return;
    const controller = new AbortController();
    let cancelled = false;

    async function consumeProgress() {
      try {
        const response = await fetch(`/api/ai-research/${jobId}/stream`, {
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
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
            if (!dataLine) continue;
            const payload = JSON.parse(dataLine.slice(6)) as Partial<InlineJob> & { finalStatus?: string | null };
            if (payload.status === 'failed' || payload.finalStatus === 'failed') {
              queryClient.invalidateQueries({ queryKey: ['inline-ai-research', jobId] });
            }
            queryClient.setQueryData<InlineJob>(['inline-ai-research', jobId], (old) => {
              if (!old) return old;
              return { ...old, ...payload };
            });
          }
        }
      } catch {
        // Polling remains active as the durable fallback when SSE is unavailable.
      }
    }

    void consumeProgress();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [jobId, liveTerminal, queryClient]);

  if (query.isLoading) {
    return (
      <section className="rounded-md border border-border bg-background p-4" aria-label="调研状态">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-3 h-2 w-full" />
        <Skeleton className="mt-4 h-12 w-full" />
      </section>
    );
  }

  if (query.isError || !query.data) {
    return (
      <section className="rounded-md border border-destructive/25 bg-destructive/5 p-4" role="alert">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertTriangle className="size-4" />
          调研状态暂时不可读
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{friendlyMessage(query.error, '请稍后重试。')}</p>
      </section>
    );
  }

  const job = query.data;
  const status = job.finalStatus ?? job.status;
  const terminal = TERMINAL.has(status);
  const pct = progressPct({
    status: job.status,
    finalStatus: job.finalStatus,
    currentStep: job.currentStep,
    researchProgress: job.researchProgress,
  });
  // Deep runs expose captured evidence through the live progress payload
  // before the durable source count catches up. Never fall back to
  // sourcesCount here: that is a discovered-page count, not proof that a
  // body was fetched and can be inspected.
  const evidenceCount = Math.max(
    job.partialSourcesCount ?? 0,
    job.researchProgress?.sourcesCaptured ?? 0,
  );
  const evidenceOnly = job.deliverableStatus === 'evidence_only';
  const userStatus = researchUserStatus({
    status,
    reportType: job.reportType,
    hasReport: Boolean(job.artifact?.content || job.outputText),
    reviewStatus: job.review?.status,
    deliverableStatus: job.deliverableStatus,
    capturedSourcesCount: evidenceCount,
  });
  const reviewUnavailable = userStatus.code === 'review_unavailable';
  const deliverableLabel = evidenceOnly
    ? '资料摘要'
    : status === 'partial'
      ? '阶段性研究稿'
      : job.reportType === 'slides'
        ? 'Slides 提纲'
        : job.reportType === 'web_brief'
          ? '网页简报'
        : job.reportType === 'summary_brief'
          ? '快速判断'
          : '研究稿';

  return (
    <section className="overflow-hidden rounded-md border border-border bg-background" aria-label="调研状态">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {userStatus.code === 'failed' || userStatus.code === 'needs_revision'
              ? <AlertTriangle className="size-4 text-warning-fg" />
              : userStatus.code === 'ready'
                ? <CheckCircle2 className="size-4 text-status-succeeded-fg" />
                : terminal
                  ? <AlertTriangle className="size-4 text-warning-fg" />
                  : <Clock3 className="size-4 text-primary" />}
            <span className="text-sm font-semibold">
              {terminal ? userStatus.label : '正在研究'}
            </span>
            <StatusBadge kind="job" value={userStatus.code === 'ready' ? 'succeeded' : userStatus.code === 'failed' ? 'failed' : 'partial'} label={userStatus.label} />
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{job.topic ?? '当前调研'}</p>
        </div>
        <Link href={`/ai-research/${job.jobId}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          打开完整任务
          <ExternalLink className="size-3" />
        </Link>
      </header>

      <div className="space-y-4 p-4">
        <StepStepper currentStep={job.currentStep} succeeded={terminal && status === 'succeeded'} />

        {reviewUnavailable ? (
          <div className="rounded-lg border border-warning-border/60 bg-warning-bg/40 px-3 py-2 text-xs leading-5 text-warning-fg" role="status">
            <strong className="font-medium">{userStatus.description}</strong>
            <span className="ml-1.5">可以打开完整任务查看依据，或稍后重新检查。</span>
          </div>
        ) : null}

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Progress value={pct} className="h-1.5 w-32 sm:w-48" />
          <span className="font-mono tabular-nums">{pct}%</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground">
            已抓取正文 <span className="ml-1 font-mono tabular-nums text-foreground">{evidenceCount}</span>
          </span>
          {terminal && status === 'partial' && job.partialSourcesCount > 0 ? (
            <span className="inline-flex items-center rounded-full border border-warning-border bg-warning-bg px-2 py-0.5 text-[11px] text-warning-fg">
              部分 <span className="ml-1 font-mono tabular-nums">{job.partialSourcesCount}</span>
            </span>
          ) : null}
          {job.failedSourcesCount > 0 ? (
            <span className="inline-flex items-center rounded-full border border-destructive/25 bg-destructive/5 px-2 py-0.5 text-[11px] text-destructive">
              失败 <span className="ml-1 font-mono tabular-nums">{job.failedSourcesCount}</span>
            </span>
          ) : null}
          <span className="inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground">
            {deliverableLabel}
          </span>
        </div>

        {job.reportLength === 'deep' && job.researchProgress?.mode === 'deep' ? (
          <DeepResearchProgressCard
            progress={job.researchProgress}
            savedSources={job.savedSourcesCount ?? job.sourcesCount}
            capturedSources={evidenceCount}
            terminalStatus={status}
            compact
          />
        ) : null}

        {status === 'failed' || status === 'partial' ? (
          <div className={cn(
            'rounded-lg border p-3 text-sm',
            status === 'partial'
              ? 'border-warning-border/60 bg-warning-bg/40 text-warning-fg'
              : 'border-destructive/25 bg-destructive/5 text-destructive',
          )} role="alert">
            <strong className="font-medium">
              {evidenceOnly
                ? '资料已保留，但没有形成可交付结论'
                : status === 'partial' ? '本次调研提前停止' : '调研失败'}
            </strong>
            <span className="ml-2">
              {job.errorCode ? friendlyMessage({ code: job.errorCode }, '调研未能继续') : '请打开完整任务查看详情。'}
            </span>
            {job.errorMessage ? <p className="mt-1.5 text-xs opacity-90">{job.errorMessage}</p> : null}
            {status === 'partial' ? (
              <p className="mt-1.5 text-xs opacity-80">
                {evidenceOnly
                  ? '已抓取的正文仍可在完整任务中核对；重新运行会重新生成研究稿，不会把这次资料摘要当成结论。'
                  : '已抓取的正文仍可核对；重新运行会创建一条新的调研任务。'}
              </p>
            ) : null}
          </div>
        ) : null}

        {status === 'succeeded' && job.artifact?.content ? (
          <div className="border-t border-border pt-4">
            {job.artifact.type === 'slides' ? (
              <ArtifactPreview content={job.artifact.content} />
            ) : job.reportType === 'web_brief' ? (
              <ResearchWebBrief
                content={job.artifact.content}
                sources={job.sources}
                reviewStatus={job.review?.status}
              />
            ) : (
              <MarkdownPreview source={job.artifact.content} className="max-h-none overflow-visible bg-card lg:max-h-[720px] lg:overflow-y-auto" />
            )}
          </div>
        ) : status === 'succeeded' && job.outputText ? (
          <MarkdownPreview source={job.outputText} className="max-h-none overflow-visible bg-card lg:max-h-[720px] lg:overflow-y-auto" />
        ) : null}

        {status === 'succeeded' && job.draftResearchId ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/researches/${job.draftResearchId}`}>打开可编辑草稿</Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
