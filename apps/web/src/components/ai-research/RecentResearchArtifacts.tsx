'use client';

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  ArrowUpRight,
  FileEdit,
  FolderOpen,
  MessageCircle,
  MoreHorizontal,
  RotateCw,
  Search,
  Sparkles,
} from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { AiResearchTaskHistory } from '@/components/ai-research/AiResearchTaskHistory';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { rerunResearchTask } from '@/components/ai-research/rerunResearchTask';
import { taskStatusBadgeValue, taskStatusLabel } from '@/lib/ai-research-task-status';
import { retryOnceAi } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { cn } from '@/lib/utils';

interface RecentResearchArtifact {
  jobId: string;
  topic: string;
  status: string;
  currentStep: string | null;
  reportType: string;
  reportLength?: 'brief' | 'standard' | 'deep';
  hasReport: boolean;
  reviewStatus?: string | null;
  capturedSourcesCount?: number;
  deliverableStatus?: 'report' | 'evidence_only' | 'none';
  sourcePolicy: string;
  sourceRefs: Array<{ type: string; value: string; required?: boolean }>;
  draftResearchId: string | null;
  publishedResearchId: string | null;
  createdAt: string | null;
}

const STEP_LABEL: Record<string, string> = {
  plan: '规划问题',
  search: '检索资料',
  compress: '整理证据',
  analyze: '分析对比',
  write: '生成产物',
  review: '整理结果',
};

const REPORT_TYPE_LABEL: Record<string, string> = {
  research_report: '研究稿',
  summary_brief: '快速判断',
  slides: 'Slides 提纲',
  web_brief: '网页简报',
};

const RESEARCH_MODE_LABEL: Record<string, string> = {
  brief: '快速研究',
  standard: '单轮研究',
  deep: '多轮研究',
};

function isTerminal(item: RecentResearchArtifact): boolean {
  return ['succeeded', 'failed', 'cancelled', 'partial'].includes(item.status);
}

function relativeTime(iso: string | null): string {
  if (!iso) return '刚刚';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function RecentTaskFooter({ openTaskHistoryOnLoad }: { openTaskHistoryOnLoad: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
      <AiResearchTaskHistory
        initialOpen={openTaskHistoryOnLoad}
        trigger={(onOpen) => (
          <Button
            id="research-history"
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-1 text-xs"
            onClick={onOpen}
          >
            查看全部任务
            <ArrowUpRight />
          </Button>
        )}
      />
      <Link
        href="/researches"
        className="inline-flex items-center gap-1 px-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <FolderOpen className="size-3.5" />
        研究库
      </Link>
    </div>
  );
}

export function RecentResearchArtifacts({
  openTaskHistoryOnLoad = false,
}: {
  openTaskHistoryOnLoad?: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const query = useQuery<{ items: RecentResearchArtifact[] }>({
    queryKey: ['ai-research-jobs', 'recent-artifacts'],
    queryFn: async () => {
      const response = await fetch('/api/ai-research/jobs?limit=3', { cache: 'no-store' });
      if (!response.ok) throw await toApiHttpError(response, '加载最近任务失败');
      return await response.json() as { items: RecentResearchArtifact[] };
    },
    retry: retryOnceAi,
    refetchInterval: (data) => (
      data.state.data?.items.some((item) => item.status === 'queued' || item.status === 'running')
        ? 8_000
        : false
    ),
  });

  async function rerun(item: RecentResearchArtifact) {
    setRerunning(item.jobId);
    setRerunError(null);
    try {
      const jobId = await rerunResearchTask(item);
      await queryClient.invalidateQueries({ queryKey: ['ai-research-jobs'] });
      router.push(`/ai-research/${jobId}`);
    } catch (error) {
      setRerunError(error instanceof Error ? error.message : '重新运行失败');
    } finally {
      setRerunning(null);
    }
  }

  return (
    <section className="border-t border-border pt-4" aria-labelledby="recent-research-tasks-heading">
      <div className="mb-2 min-w-0">
        <h2 id="recent-research-tasks-heading" className="flex items-center gap-1.5 text-xs font-semibold">
          <Sparkles className="size-3.5 text-primary" />
          最近任务
        </h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">最近 3 项，继续查看或恢复工作</p>
      </div>

      {query.isLoading ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((item) => <Skeleton key={item} className="h-20 w-full rounded-md" />)}
        </div>
      ) : query.isError ? (
        <div className="space-y-2">
          <div className="rounded-md border border-destructive/30 bg-destructive/[0.04] p-3 text-xs text-destructive">
            最近任务暂时无法加载。
            <button type="button" className="ml-1 font-medium underline underline-offset-2" onClick={() => void query.refetch()}>
              重试
            </button>
          </div>
          <RecentTaskFooter openTaskHistoryOnLoad={openTaskHistoryOnLoad} />
        </div>
      ) : query.data?.items.length ? (
        <div className="space-y-2">
          {query.data.items.map((item) => {
            const finished = isTerminal(item);
            const inFlight = item.status === 'queued' || item.status === 'running';
            const hasReaderReport = item.deliverableStatus === 'report' || (
              item.deliverableStatus === undefined && item.hasReport
            );
            const evidenceOnly = item.deliverableStatus === 'evidence_only';
            const canContinue = finished &&
              hasReaderReport &&
              item.status !== 'failed' &&
              item.status !== 'cancelled' &&
              item.reportType !== 'summary_brief';
            const hasMenuActions = Boolean(item.draftResearchId || canContinue || !inFlight);
            const mainLabel = !finished ? '查看进度' : evidenceOnly || !hasReaderReport ? '查看资料' : '查看结果';

            return (
              <article
                key={item.jobId}
                className="rounded-md border border-border bg-card p-3 transition-colors hover:border-primary/35"
              >
                <div className="flex items-start gap-2">
                  <span className={cn(
                    'mt-0.5 grid size-6 shrink-0 place-items-center rounded-md',
                    finished && hasReaderReport ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
                  )}>
                    {finished && hasReaderReport
                      ? <FileEdit className="size-3.5" />
                      : <Search className="size-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 pr-1">
                      <StatusBadge kind="job" value={taskStatusBadgeValue(item)} label={taskStatusLabel(item)} />
                      <span className="text-[11px] text-muted-foreground">
                        {RESEARCH_MODE_LABEL[item.reportLength ?? 'standard'] ?? '研究深度'} ·{' '}
                        {REPORT_TYPE_LABEL[item.reportType] ?? '调研任务'} · {relativeTime(item.createdAt)}
                      </span>
                    </div>
                    <p
                      className="mt-1 line-clamp-2 text-sm font-medium leading-5"
                      title={item.topic}
                    >
                      {item.topic}
                    </p>
                    {!finished && item.currentStep ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        当前：{STEP_LABEL[item.currentStep] ?? item.currentStep}
                      </p>
                    ) : null}
                  </div>
                  {hasMenuActions ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0"
                          title={`更多操作：${item.topic}`}
                          aria-label={`更多操作：${item.topic}`}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {item.draftResearchId ? (
                          <DropdownMenuItem asChild>
                            <Link href={`/researches/${item.draftResearchId}/edit`}>
                              <FileEdit />
                              打开草稿
                            </Link>
                          </DropdownMenuItem>
                        ) : null}
                        {canContinue ? (
                          <DropdownMenuItem asChild>
                            <Link href={`/ai-research/${item.jobId}#research-chat`}>
                              <MessageCircle />
                              继续追问
                            </Link>
                          </DropdownMenuItem>
                        ) : null}
                        {!inFlight ? (
                          <DropdownMenuItem
                            disabled={rerunning === item.jobId}
                            onSelect={() => void rerun(item)}
                          >
                            <RotateCw className={cn(rerunning === item.jobId && 'animate-spin')} />
                            {rerunning === item.jobId ? '重新运行中…' : '重新运行'}
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 pl-8">
                  <Link href={`/ai-research/${item.jobId}`} className="text-xs font-medium text-primary hover:underline">
                    {mainLabel}
                  </Link>
                  {item.publishedResearchId ? (
                    <span className="text-[11px] text-muted-foreground">已进入研究库</span>
                  ) : null}
                </div>
              </article>
            );
          })}
          {rerunError ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/[0.04] px-3 py-2 text-xs text-destructive">
              {rerunError}
            </p>
          ) : null}
          <RecentTaskFooter openTaskHistoryOnLoad={openTaskHistoryOnLoad} />
        </div>
      ) : (
        <div className="space-y-2">
          <EmptyState title="还没有研究任务" description="提交一次 AI 调研后，最近任务会出现在这里。" />
          <RecentTaskFooter openTaskHistoryOnLoad={openTaskHistoryOnLoad} />
        </div>
      )}
    </section>
  );
}
