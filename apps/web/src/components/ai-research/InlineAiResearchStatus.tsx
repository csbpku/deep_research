'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AlertTriangle, Check, CheckCircle2, Clock3, ExternalLink } from 'lucide-react';
import Link from 'next/link';

import { ArtifactPreview } from '@/components/ai-research/ArtifactPreview';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { Progress } from '@/components/ui/progress';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toApiHttpError } from '@/lib/errors/api-error';
import { retryOnceAi, friendlyMessage } from '@/lib/errors/friendly';
import { progressPct } from '@/lib/ai-progress';
import { cn } from '@/lib/utils';

interface InlineJob {
  jobId: string;
  topic: string | null;
  status: string;
  finalStatus: string | null;
  currentStep: string | null;
  sourcesCount: number;
  partialSourcesCount: number;
  failedSourcesCount: number;
  draftResearchId: string | null;
  reportType: string | null;
  outputText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  artifact: {
    type: 'markdown' | 'slides' | 'table' | 'chart';
    title: string;
    content: string | null;
  } | null;
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

function labelForStatus(status: string): string {
  if (status === 'queued') return '排队中';
  if (status === 'running') return '调研进行中';
  if (status === 'succeeded') return '已完成';
  if (status === 'partial') return '部分完成';
  if (status === 'cancelled') return '已取消';
  if (status === 'failed') return '失败';
  return status;
}

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
      <section className="rounded-xl border border-border bg-background p-4" aria-label="调研状态">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-3 h-2 w-full" />
        <Skeleton className="mt-4 h-12 w-full" />
      </section>
    );
  }

  if (query.isError || !query.data) {
    return (
      <section className="rounded-xl border border-destructive/25 bg-destructive/5 p-4" role="alert">
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
  });

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-background" aria-label="调研状态">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {terminal && status === 'succeeded' ? <CheckCircle2 className="size-4 text-status-succeeded-fg" /> : <Clock3 className="size-4 text-primary" />}
            <span className="text-sm font-semibold">{terminal ? '调研结果已回到当前页面' : '调研正在当前页面运行'}</span>
            <StatusBadge kind="job" value={labelForStatus(status)} label={labelForStatus(status)} />
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

        <div className="flex items-center justify-end text-xs text-muted-foreground">
          <span className="font-mono tabular-nums">{pct}%</span>
        </div>
        <Progress value={pct} />

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground">
            来源 <span className="ml-1 font-mono tabular-nums text-foreground">{job.sourcesCount}</span>
          </span>
          {job.partialSourcesCount > 0 ? (
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
            {job.reportType === 'slides' ? '演示稿' : job.reportType === 'summary_brief' ? '简报' : '研究稿'}
          </span>
        </div>

        {status === 'failed' ? (
          <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">
            {job.errorMessage ?? job.errorCode ?? '调研失败，请打开完整任务查看详情。'}
          </div>
        ) : null}

        {status === 'succeeded' && job.artifact?.content ? (
          <div className="border-t border-border pt-4">
            {job.artifact.type === 'slides' ? (
              <ArtifactPreview content={job.artifact.content} />
            ) : (
              <MarkdownPreview source={job.artifact.content} className="max-h-[720px] bg-card" />
            )}
          </div>
        ) : status === 'succeeded' && job.outputText ? (
          <MarkdownPreview source={job.outputText} className="max-h-[720px] bg-card" />
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
