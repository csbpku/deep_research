'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock3, ExternalLink, Loader2 } from 'lucide-react';
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

export function InlineAiResearchStatus({ jobId }: { jobId: string }) {
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

      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{job.currentStep ? STEP_LABELS[job.currentStep] ?? job.currentStep : '准备中'}</span>
          <span className="font-mono tabular-nums">{pct}%</span>
        </div>
        <Progress value={pct} />
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <Metric label="已抓取来源" value={job.sourcesCount} />
          <Metric label="部分来源" value={job.partialSourcesCount} />
          <Metric label="失败来源" value={job.failedSourcesCount} />
          <Metric label="产物" value={job.reportType === 'slides' ? 'Slides' : job.reportType === 'summary_brief' ? '简报' : '研究稿'} />
        </div>

        {!terminal ? (
          <p className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            你可以留在这里继续看进度，完成后结果会直接出现在下方。
          </p>
        ) : null}

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
              <MarkdownPreview source={job.artifact.content} className="max-h-[520px] bg-card" />
            )}
          </div>
        ) : status === 'succeeded' && job.outputText ? (
          <MarkdownPreview source={job.outputText} className="max-h-[520px] bg-card" />
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

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={cn('rounded-lg border border-border bg-card px-3 py-2')}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}
