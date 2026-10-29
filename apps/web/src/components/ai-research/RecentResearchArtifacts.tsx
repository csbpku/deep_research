'use client';

import { formatResearchRelativeTime as relativeTime } from '@/lib/ai-research-state';

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import React, { useState } from 'react';
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
import { AiResearchButton as Button } from '@/components/ai-research/AiResearchMaterial';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import MuiLink from '@mui/material/Link';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { rerunResearchTask } from '@/components/ai-research/rerunResearchTask';
import { taskStatusBadgeValue, taskStatusLabel } from '@/lib/ai-research-task-status';
import { retryOnceAi } from '@/lib/errors/friendly';
import { ApiHttpError, toApiHttpError } from '@/lib/errors/api-error';

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



function RecentTaskFooter({ openTaskHistoryOnLoad }: { openTaskHistoryOnLoad: boolean }) {
  return (
    <Stack direction="row" useFlexGap spacing={1} sx={{ pt: 0.5, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
      <AiResearchTaskHistory
        initialOpen={openTaskHistoryOnLoad}
        trigger={(onOpen) => (
          <Button
            id="research-history"
            type="button"
            variant="link"
            size="xs"
            onClick={onOpen}
          >
            查看全部任务
            <ArrowUpRight size={14} />
          </Button>
        )}
      />
      <MuiLink component={Link} href="/researches" underline="hover" color="text.secondary" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, typography: 'metadata', px: 0.5 }}>
        <FolderOpen size={14} />
        研究库
      </MuiLink>
    </Stack>
  );
}

export function RecentResearchArtifacts({
  openTaskHistoryOnLoad = false,
}: {
  openTaskHistoryOnLoad?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [menuJobId, setMenuJobId] = useState<string | null>(null);
  const query = useQuery<{ items: RecentResearchArtifact[] }>({
    queryKey: ['ai-research-jobs', 'recent-artifacts'],
    queryFn: async () => {
      const response = await fetch('/api/ai-research/jobs?limit=3', { cache: 'no-store' });
      if (!response.ok) throw await toApiHttpError(response, '加载最近任务失败');
      return await response.json() as { items: RecentResearchArtifact[] };
    },
    retry: (count, error) => !(error instanceof ApiHttpError && error.status === 401) && retryOnceAi(count, error),
    refetchOnMount: (query) => !(query.state.error instanceof ApiHttpError && query.state.error.status === 401),
    refetchOnWindowFocus: (query) => !(query.state.error instanceof ApiHttpError && query.state.error.status === 401),
    refetchOnReconnect: (query) => !(query.state.error instanceof ApiHttpError && query.state.error.status === 401),
    refetchInterval: (data) => (
      !(data.state.error instanceof ApiHttpError && data.state.error.status === 401)
      && data.state.data?.items.some((item) => item.status === 'queued' || item.status === 'running')
        ? 8_000
        : false
    ),
  });
  const loginRequired = query.isError && query.error instanceof ApiHttpError && query.error.status === 401;

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
    <Box component="section" sx={{ pt: 2, borderTop: 1, borderColor: 'divider' }} aria-labelledby="recent-research-tasks-heading">
      <Box sx={{ mb: 1.5, minWidth: 0 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Sparkles size={14} color="var(--dr-color-primary)" />
          <Typography id="recent-research-tasks-heading" variant="fieldTitle" component="h2">最近任务</Typography>
        </Stack>
        <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>最近 3 项，继续查看或恢复工作</Typography>
      </Box>

      {query.isLoading ? (
        <Stack spacing={1} aria-busy="true">
          {[0, 1, 2].map((item) => <Skeleton key={item} variant="rounded" height={80} />)}
        </Stack>
      ) : loginRequired ? (
        <Alert severity="info" action={
          <Button asChild variant="link" size="xs">
            <Link href={`/signin?${new URLSearchParams({ callbackUrl: pathname || '/ai-research' })}`}>登录</Link>
          </Button>
        }>
          登录后查看最近任务。
        </Alert>
      ) : query.isError ? (
        <Stack spacing={1.5}>
          <Alert severity="error" action={<Button type="button" variant="link" size="xs" onClick={() => void query.refetch()}>重试</Button>}>
            最近任务暂时无法加载。
          </Alert>
          <RecentTaskFooter openTaskHistoryOnLoad={openTaskHistoryOnLoad} />
        </Stack>
      ) : query.data?.items.length ? (
        <Stack spacing={1.5}>
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
              <Paper component="article" variant="outlined" key={item.jobId} sx={{ p: 1.5, transition: 'border-color 120ms ease-out', '&:hover': { borderColor: 'primary.main' } }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                  <Box sx={{ mt: 0.5, width: 28, height: 28, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 1, bgcolor: finished && hasReaderReport ? 'action.hover' : 'action.selected', color: finished && hasReaderReport ? 'text.secondary' : 'primary.main' }}>
                    {finished && hasReaderReport ? <FileEdit size={16} /> : <Search size={16} />}
                  </Box>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="listTitle" component="h3" title={item.topic} sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>
                      <MuiLink component={Link} href={`/ai-research/${item.jobId}`} color="inherit" underline="hover">{item.topic}</MuiLink>
                    </Typography>
                    <MuiLink component={Link} href={`/ai-research/${item.jobId}`} underline="hover" sx={{ display: 'inline-flex', mt: 0.5, typography: 'metadata', fontWeight: 500 }}>{mainLabel}</MuiLink>
                    <Stack direction="row" useFlexGap spacing={1} sx={{ mt: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                      <StatusBadge kind="job" value={taskStatusBadgeValue(item)} label={taskStatusLabel(item)} />
                      <Typography variant="metadata" color="text.secondary">
                        {RESEARCH_MODE_LABEL[item.reportLength ?? 'standard'] ?? '研究深度'} ·{' '}
                        {REPORT_TYPE_LABEL[item.reportType] ?? '调研任务'} · {relativeTime(item.createdAt)}
                      </Typography>
                    </Stack>
                    {!finished && item.currentStep ? <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>当前：{STEP_LABEL[item.currentStep] ?? item.currentStep}</Typography> : null}
                  </Box>
                  {hasMenuActions ? (
                    <>
                      <IconButton
                        size="small"
                        title={`更多操作：${item.topic}`}
                        aria-label={`更多操作：${item.topic}`}
                        aria-haspopup="menu"
                        aria-expanded={menuJobId === item.jobId && Boolean(menuAnchor)}
                        onClick={(event) => { setMenuJobId(item.jobId); setMenuAnchor(event.currentTarget); }}
                        sx={{ flexShrink: 0 }}
                      >
                        <MoreHorizontal size={18} />
                      </IconButton>
                      <Menu
                        anchorEl={menuJobId === item.jobId ? menuAnchor : null}
                        open={menuJobId === item.jobId && Boolean(menuAnchor)}
                        onClose={() => { setMenuAnchor(null); setMenuJobId(null); }}
                        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                      >
                        {item.draftResearchId ? (
                          <MenuItem component={Link} href={`/researches/${item.draftResearchId}/edit`} onClick={() => { setMenuAnchor(null); setMenuJobId(null); }}>
                            <FileEdit size={16} />打开草稿
                          </MenuItem>
                        ) : null}
                        {canContinue ? (
                          <MenuItem component={Link} href={`/ai-research/${item.jobId}#research-chat`} onClick={() => { setMenuAnchor(null); setMenuJobId(null); }}>
                            <MessageCircle size={16} />继续追问
                          </MenuItem>
                        ) : null}
                        {!inFlight ? (
                          <MenuItem disabled={rerunning === item.jobId} onClick={() => { setMenuAnchor(null); setMenuJobId(null); void rerun(item); }}>
                            <RotateCw size={16} />{rerunning === item.jobId ? '重新运行中…' : '重新运行'}
                          </MenuItem>
                        ) : null}
                      </Menu>
                    </>
                  ) : null}
                </Stack>
                {item.publishedResearchId ? <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 1, pl: 4.5 }}>已进入研究库</Typography> : null}
              </Paper>
            );
          })}
          {rerunError ? <Alert severity="error" role="alert">{rerunError}</Alert> : null}
          <RecentTaskFooter openTaskHistoryOnLoad={openTaskHistoryOnLoad} />
        </Stack>
      ) : (
        <Stack spacing={1.5}>
          <EmptyState title="还没有研究任务" description="提交一次 AI 调研后，最近任务会出现在这里。" />
          <RecentTaskFooter openTaskHistoryOnLoad={openTaskHistoryOnLoad} />
        </Stack>
      )}
    </Box>
  );
}
