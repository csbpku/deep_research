'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Loader2,
  RotateCw,
} from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { friendlyMessage, retryOnceAi } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { rerunResearchTask } from '@/components/ai-research/rerunResearchTask';
import { taskStatusBadgeValue, taskStatusLabel } from '@/lib/ai-research-task-status';
import { cn } from '@/lib/utils';

interface HistoryItem {
  jobId: string;
  topic: string;
  status: string;
  finalStatus?: string | null;
  reviewStatus?: string | null;
  currentStep: string | null;
  reportType: string;
  reportLength?: 'brief' | 'standard' | 'deep';
  hasReport: boolean;
  capturedSourcesCount?: number;
  deliverableStatus?: 'report' | 'evidence_only' | 'none';
  sourcePolicy: string;
  sourceRefs: Array<{ type: string; value: string; required?: boolean }>;
  draftResearchId: string | null;
  publishedResearchId: string | null;
  createdAt: string | null;
}

type HistoryFilter = 'all' | 'running' | 'published' | 'failed' | 'cancelled';

const FILTERS: Array<{ key: HistoryFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '进行中' },
  { key: 'published', label: '已发布' },
  { key: 'failed', label: '失败' },
  { key: 'cancelled', label: '已取消' },
];

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

const STEP_LABEL: Record<string, string> = {
  plan: '规划问题',
  search: '检索资料',
  compress: '整理证据',
  analyze: '分析对比',
  write: '生成产物',
  review: '整理结果',
};

function filterToQuery(key: HistoryFilter): string {
  switch (key) {
    case 'running':
      return 'queued,running';
    case 'published':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'all':
      return '';
  }
}

function itemMatchesFilter(item: HistoryItem, key: HistoryFilter): boolean {
  if (key === 'all') return true;
  if (key === 'running') return item.status === 'queued' || item.status === 'running';
  if (key === 'published') return item.publishedResearchId !== null;
  return item.status === key;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '刚刚';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return `${Math.floor(day / 30)} 个月前`;
}

function StatusIcon({ item }: { item: HistoryItem }) {
  if (item.deliverableStatus === 'evidence_only') {
    return <AlertTriangle className="size-4 shrink-0 text-warning-fg" />;
  }
  if (taskStatusBadgeValue(item) === 'partial') {
    return <AlertTriangle className="size-4 shrink-0 text-warning-fg" />;
  }
  const hasReaderReport = item.deliverableStatus === 'report' || (
    item.deliverableStatus === undefined && item.hasReport
  );
  if (item.publishedResearchId || (item.status === 'succeeded' && hasReaderReport)) {
    return <CheckCircle2 className="size-4 shrink-0 text-status-succeeded-fg" />;
  }
  if (item.status === 'failed' || item.status === 'cancelled' || item.status === 'partial') {
    return <AlertTriangle className="size-4 shrink-0 text-status-failed-fg" />;
  }
  return <Loader2 className="size-4 shrink-0 animate-spin text-status-running-fg" />;
}

async function fetchJobs(params: URLSearchParams): Promise<{ items: HistoryItem[]; total: number }> {
  const response = await fetch(`/api/ai-research/jobs?${params.toString()}`, { cache: 'no-store' });
  if (!response.ok) throw await toApiHttpError(response, '加载调研任务失败');
  return await response.json() as { items: HistoryItem[]; total: number };
}

function HistoryActions({ item, rerunning, onRerun }: {
  item: HistoryItem;
  rerunning: string | null;
  onRerun: (item: HistoryItem) => void;
}) {
  const inFlight = item.status === 'queued' || item.status === 'running';

  return (
    <div className="flex justify-end gap-1">
      <Button asChild variant="link" size="xs">
        <Link href={`/ai-research/${item.jobId}`}>打开</Link>
      </Button>
      <Button
        type="button"
        variant="link"
        size="xs"
        disabled={inFlight || rerunning === item.jobId}
        onClick={() => onRerun(item)}
        title="沿用原问题、资料和设置重新运行"
      >
        <RotateCw className={cn(rerunning === item.jobId && 'animate-spin')} />
        {rerunning === item.jobId ? '运行中…' : '重新运行'}
      </Button>
    </div>
  );
}

function HistoryTable({ items, rerunning, onRerun }: {
  items: HistoryItem[];
  rerunning: string | null;
  onRerun: (item: HistoryItem) => void;
}) {
  return (
    <>
      <div className="space-y-2 sm:hidden">
        {items.map((item) => {
          const inFlight = item.status === 'queued' || item.status === 'running';
          return (
            <article key={item.jobId} className="rounded-md border border-border bg-card p-3">
              <div className="flex items-start gap-2">
                <StatusIcon item={item} />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 font-medium">{item.topic}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {RESEARCH_MODE_LABEL[item.reportLength ?? 'standard'] ?? '研究深度'}
                    {' · '}
                    {REPORT_TYPE_LABEL[item.reportType] ?? '调研任务'}
                    {item.currentStep ? ` · ${STEP_LABEL[item.currentStep] ?? item.currentStep}` : ''}
                  </p>
                </div>
                <StatusBadge kind="job" value={taskStatusBadgeValue(item)} label={taskStatusLabel(item)} />
              </div>
              {inFlight && item.currentStep ? (
                <p className="mt-2 pl-6 text-[11px] text-muted-foreground">当前：{STEP_LABEL[item.currentStep] ?? item.currentStep}</p>
              ) : null}
              <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                <span className="text-[11px] text-muted-foreground">{relativeTime(item.createdAt)}</span>
                <HistoryActions item={item} rerunning={rerunning} onRerun={onRerun} />
              </div>
            </article>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto rounded-md border border-border bg-card sm:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>主题</TableHead>
              <TableHead className="w-36">状态</TableHead>
              <TableHead className="w-28">创建时间</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const inFlight = item.status === 'queued' || item.status === 'running';
              return (
                <TableRow key={item.jobId}>
                  <TableCell className="min-w-56">
                    <div className="flex items-start gap-2">
                      <StatusIcon item={item} />
                      <div className="min-w-0">
                        <p className="line-clamp-2 font-medium">{item.topic}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {RESEARCH_MODE_LABEL[item.reportLength ?? 'standard'] ?? '研究深度'}
                          {' · '}
                          {REPORT_TYPE_LABEL[item.reportType] ?? '调研任务'}
                          {item.currentStep ? ` · ${STEP_LABEL[item.currentStep] ?? item.currentStep}` : ''}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <StatusBadge kind="job" value={taskStatusBadgeValue(item)} label={taskStatusLabel(item)} />
                      {inFlight && item.currentStep ? (
                        <p className="text-[11px] text-muted-foreground">当前：{STEP_LABEL[item.currentStep] ?? item.currentStep}</p>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{relativeTime(item.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <HistoryActions item={item} rerunning={rerunning} onRerun={onRerun} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

export function AiResearchTaskHistory({
  initialOpen = false,
  trigger,
}: {
  initialOpen?: boolean;
  trigger?: (onOpen: () => void) => ReactNode;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);

  useEffect(() => {
    if (initialOpen) setHistoryOpen(true);
  }, [initialOpen]);

  const historyQuery = useQuery<{ items: HistoryItem[]; total: number }>({
    queryKey: ['ai-research-jobs', 'history', filter],
    enabled: historyOpen,
    queryFn: async () => {
      const params = new URLSearchParams({ limit: '50' });
      const status = filterToQuery(filter);
      if (status) params.set('status', status);
      return await fetchJobs(params);
    },
    retry: retryOnceAi,
  });

  async function rerun(item: HistoryItem) {
    setRerunning(item.jobId);
    setRerunError(null);
    try {
      const jobId = await rerunResearchTask(item);
      await queryClient.invalidateQueries({ queryKey: ['ai-research-jobs'] });
      setHistoryOpen(false);
      router.push(`/ai-research/${jobId}`);
    } catch (error) {
      setRerunError(error instanceof Error ? error.message : '重新运行失败');
    } finally {
      setRerunning(null);
    }
  }

  const historyItems = (historyQuery.data?.items ?? []).filter((item) => itemMatchesFilter(item, filter));

  return (
    <>
      {/*
       * 历史是恢复入口，不是新建研究的主任务。把完整列表放进一个
       * header launcher，避免新建页同时出现“最近对话”和第二套任务列表。
       */}
      {trigger ? trigger(() => setHistoryOpen(true)) : (
        <Button
          id="research-history"
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setHistoryOpen(true)}
        >
          <FolderOpen className="size-3.5" />
          历史任务
        </Button>
      )}

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" className="flex w-full max-w-4xl flex-col gap-0 p-0 sm:max-w-4xl">
          <SheetHeader>
            <SheetTitle>调研历史</SheetTitle>
            <SheetDescription>查看过去的研究任务、恢复结果，或用相同范围重新运行。</SheetDescription>
          </SheetHeader>
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-3">
            {FILTERS.map((item) => (
              <Button
                key={item.key}
                type="button"
                size="xs"
                variant={filter === item.key ? 'default' : 'outline'}
                className="rounded-full"
                onClick={() => setFilter(item.key)}
              >
                {item.label}
              </Button>
            ))}
            {historyQuery.data ? <span className="ml-auto text-xs text-muted-foreground">共 {historyQuery.data.total} 条</span> : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {rerunError ? <div role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive">{rerunError}</div> : null}
            {historyQuery.isLoading ? (
              <div className="space-y-3">
                {[0, 1, 2, 3].map((item) => <Skeleton key={item} className="h-16 w-full rounded-md" />)}
              </div>
            ) : historyQuery.isError ? (
              <EmptyState
                title="历史任务加载失败"
                description={friendlyMessage(historyQuery.error, '请稍后重试')}
                action={<Button type="button" size="sm" onClick={() => void historyQuery.refetch()}>重试</Button>}
              />
            ) : historyItems.length === 0 ? (
              <EmptyState
                title={filter === 'all' ? '还没有调研任务' : '当前筛选下没有任务'}
                description={filter === 'all' ? '提交一次研究后，任务状态和结果会在这里持续可见。' : '换一个筛选条件看看。'}
              />
            ) : (
              <HistoryTable items={historyItems} rerunning={rerunning} onRerun={(item) => void rerun(item)} />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
