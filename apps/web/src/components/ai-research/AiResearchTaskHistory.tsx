'use client';

import { formatResearchRelativeTime as relativeTime } from '@/lib/ai-research-state';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { type ReactNode, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  RotateCw,
} from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/StateMessage';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { AiResearchButton as Button } from '@/components/ai-research/AiResearchMaterial';
import { AppDrawer } from '@/components/material/AppDrawer';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { friendlyMessage, retryOnceAi } from '@/lib/errors/friendly';
import { ApiHttpError, toApiHttpError } from '@/lib/errors/api-error';
import { rerunResearchTask } from '@/components/ai-research/rerunResearchTask';
import { taskStatusBadgeValue, taskStatusLabel } from '@/lib/ai-research-task-status';

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



function StatusIcon({ item }: { item: HistoryItem }) {
  if (item.deliverableStatus === 'evidence_only') {
    return <AlertTriangle size={16} color="var(--dr-color-warning)" aria-hidden="true" />;
  }
  if (taskStatusBadgeValue(item) === 'partial') {
    return <AlertTriangle size={16} color="var(--dr-color-warning)" aria-hidden="true" />;
  }
  const hasReaderReport = item.deliverableStatus === 'report' || (
    item.deliverableStatus === undefined && item.hasReport
  );
  if (item.publishedResearchId || (item.status === 'succeeded' && hasReaderReport)) {
    return <CheckCircle2 size={16} color="var(--dr-color-success)" aria-hidden="true" />;
  }
  if (item.status === 'failed' || item.status === 'cancelled' || item.status === 'partial') {
    return <AlertTriangle size={16} color="var(--dr-color-danger)" aria-hidden="true" />;
  }
  return <CircularProgress size={16} color="info" aria-label="进行中" />;
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
    <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
      <Button asChild variant="link" size="xs">
        <Link href={`/ai-research?job=${item.jobId}`}>打开</Link>
      </Button>
      <Button
        type="button"
        variant="link"
        size="xs"
        disabled={inFlight || rerunning === item.jobId}
        onClick={() => onRerun(item)}
        title="沿用原问题、资料和设置重新运行"
      >
        <RotateCw size={16} />
        {rerunning === item.jobId ? '运行中…' : '重新运行'}
      </Button>
    </Stack>
  );
}

function HistoryTable({ items, rerunning, onRerun }: {
  items: HistoryItem[];
  rerunning: string | null;
  onRerun: (item: HistoryItem) => void;
}) {
  return (
    <>
      <Stack spacing={1.5} sx={{ display: { xs: 'flex', sm: 'none' } }}>
        {items.map((item) => {
          const inFlight = item.status === 'queued' || item.status === 'running';
          return (
            <Paper component="article" variant="outlined" key={item.jobId} sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                <StatusIcon item={item} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="listTitle" component="h3" sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{item.topic}</Typography>
                  <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    {RESEARCH_MODE_LABEL[item.reportLength ?? 'standard'] ?? '研究深度'}
                    {' · '}
                    {REPORT_TYPE_LABEL[item.reportType] ?? '调研任务'}
                    {item.currentStep ? ` · ${STEP_LABEL[item.currentStep] ?? item.currentStep}` : ''}
                  </Typography>
                </Box>
                <StatusBadge kind="job" value={taskStatusBadgeValue(item)} label={taskStatusLabel(item)} />
              </Stack>
              {inFlight && item.currentStep ? (
                <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 1, pl: 3.5 }}>当前：{STEP_LABEL[item.currentStep] ?? item.currentStep}</Typography>
              ) : null}
              <Stack direction="row" spacing={1} sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: 'divider', alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="metadata" color="text.secondary">{relativeTime(item.createdAt)}</Typography>
                <HistoryActions item={item} rerunning={rerunning} onRerun={onRerun} />
              </Stack>
            </Paper>
          );
        })}
      </Stack>

      <TableContainer component={Paper} variant="outlined" sx={{ display: { xs: 'none', sm: 'block' }, overflowX: 'auto' }}>
        <Table size="small" aria-label="调研历史任务">
          <TableHead>
            <TableRow sx={{ '&:hover': { bgcolor: 'transparent' } }}>
              <TableCell component="th" scope="col">主题</TableCell>
              <TableCell component="th" scope="col" sx={{ width: 144 }}>状态</TableCell>
              <TableCell component="th" scope="col" sx={{ width: 112 }}>创建时间</TableCell>
              <TableCell component="th" scope="col" sx={{ width: 144, textAlign: 'right' }}>操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((item) => {
              const inFlight = item.status === 'queued' || item.status === 'running';
              return (
                <TableRow key={item.jobId}>
                  <TableCell sx={{ minWidth: 224 }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                      <StatusIcon item={item} />
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="listTitle" component="h3" sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{item.topic}</Typography>
                        <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                          {RESEARCH_MODE_LABEL[item.reportLength ?? 'standard'] ?? '研究深度'}
                          {' · '}
                          {REPORT_TYPE_LABEL[item.reportType] ?? '调研任务'}
                          {item.currentStep ? ` · ${STEP_LABEL[item.currentStep] ?? item.currentStep}` : ''}
                        </Typography>
                      </Box>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Stack spacing={0.5}>
                      <StatusBadge kind="job" value={taskStatusBadgeValue(item)} label={taskStatusLabel(item)} />
                      {inFlight && item.currentStep ? (
                        <Typography variant="metadata" color="text.secondary">当前：{STEP_LABEL[item.currentStep] ?? item.currentStep}</Typography>
                      ) : null}
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap', color: 'text.secondary', typography: 'metadata' }}>{relativeTime(item.createdAt)}</TableCell>
                  <TableCell sx={{ textAlign: 'right' }}>
                    <HistoryActions item={item} rerunning={rerunning} onRerun={onRerun} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
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
  const pathname = usePathname();
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
    retry: (count, error) => !(error instanceof ApiHttpError && error.status === 401) && retryOnceAi(count, error),
    refetchOnMount: (query) => !(query.state.error instanceof ApiHttpError && query.state.error.status === 401),
    refetchOnWindowFocus: (query) => !(query.state.error instanceof ApiHttpError && query.state.error.status === 401),
    refetchOnReconnect: (query) => !(query.state.error instanceof ApiHttpError && query.state.error.status === 401),
  });
  const loginRequired = historyQuery.isError && historyQuery.error instanceof ApiHttpError && historyQuery.error.status === 401;

  async function rerun(item: HistoryItem) {
    setRerunning(item.jobId);
    setRerunError(null);
    try {
      const jobId = await rerunResearchTask(item);
      await queryClient.invalidateQueries({ queryKey: ['ai-research-jobs'] });
      setHistoryOpen(false);
      router.push(`/ai-research?job=${jobId}`);
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
          onClick={() => setHistoryOpen(true)}
        >
          <FolderOpen size={14} />
          历史任务
        </Button>
      )}

      <AppDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} anchor="left" title="调研历史" description="查看过去的研究任务、恢复结果，或用相同范围重新运行。" width="min(100vw, 56rem)">
        <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <Stack direction="row" useFlexGap spacing={0.5} sx={{ flexWrap: 'wrap', alignItems: 'center', borderBottom: 1, borderColor: 'divider', px: 2, py: 1.5 }}>
            {FILTERS.map((item) => (
              <Button
                key={item.key}
                type="button"
                size="xs"
                variant={filter === item.key ? 'default' : 'outline'}
                sx={{ minHeight: 'var(--dr-control-height)' }}
                onClick={() => setFilter(item.key)}
              >
                {item.label}
              </Button>
            ))}
            {!loginRequired && historyQuery.data ? <Typography variant="metadata" color="text.secondary" sx={{ ml: 'auto' }}>共 {historyQuery.data.total} 条</Typography> : null}
          </Stack>
          <Box sx={{ minHeight: 0, flex: 1, overflowY: 'auto', p: 2 }}>
            {rerunError ? <Alert severity="error" role="alert" sx={{ mb: 1.5 }}>{rerunError}</Alert> : null}
            {historyQuery.isLoading ? (
              <Stack spacing={1.5}>
                {[0, 1, 2, 3].map((item) => <Skeleton key={item} variant="rounded" height={64} />)}
              </Stack>
            ) : loginRequired ? (
              <Alert severity="info" action={
                <Button asChild variant="link" size="xs">
                  <Link href={`/signin?${new URLSearchParams({ callbackUrl: pathname || '/ai-research' })}`}>登录</Link>
                </Button>
              }>
                登录后查看历史任务。
              </Alert>
            ) : historyQuery.isError ? (
              <ErrorState
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
          </Box>
        </Box>
      </AppDrawer>
    </>
  );
}
