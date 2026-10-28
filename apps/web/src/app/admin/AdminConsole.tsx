'use client';

// Admin 控制台客户端组件 —— Week 8：仪表板 + 调研库管理 + 3 个审核队列。
// 由 app/admin/page.tsx（Server Component）做鉴权拦截后渲染。

import { Fragment, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Checkbox, Paper, Typography } from '@mui/material';
import {
  Activity,
  AlertTriangle,
  Archive,
  ExternalLink,
  FileWarning,
  CalendarDays,
  Check,
  CheckCircle2,
  CircleAlert,
  ChevronDown,
  DollarSign,
  Eye,
  EyeOff,
  Library,
  Lightbulb,
  Link2,
  LoaderCircle,
  ListFilter,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Search as SearchIcon,
  Star,
  User,
  UserPlus,
  Radar as RadarIcon,
  ShieldCheck,
  Sparkles,
  Timer,
  X,
} from 'lucide-react';

import { StatCard } from '@/components/domain/StatCard';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/domain/PageHeader';
import { Pagination } from '@/components/domain/Pagination';
import { StatusBadge } from '@/components/domain/StatusBadge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Button,
  Input,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Card,
  CardContent,
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  adminRootSx,
} from './AdminMaterial';
import { AdminActionDialog } from '@/components/admin/AdminActionDialog';
import { AppButton } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';
import { formatSourceType } from '@/lib/radar/source-labels';
import { cleanResearchText } from '@/lib/research-markdown-cleanup';
import { TopicProposalsTab } from '@/components/admin/TopicProposalsTab';
import { AdminTopicActions } from '@/components/topics/AdminTopicActions';
import LlmUsageConsole from './llm-usage/LlmUsageConsole';
import { summarizeAdminBulkResults } from './admin-bulk-results';

export const ADMIN_TAB_KEYS = [
  'dashboard',
  'radar',
  'researches',
  'topics',
  'shares',
  'comments',
  'llm_usage',
  'users',
] as const;
type Tab = typeof ADMIN_TAB_KEYS[number];

const TABS: { key: Tab; label: string; icon: typeof RadarIcon }[] = [
  { key: 'dashboard', label: '仪表板', icon: ShieldCheck },
  { key: 'radar', label: '雷达治理', icon: RadarIcon },
  { key: 'researches', label: '研究库', icon: Library },
  { key: 'topics', label: '主题提议', icon: Sparkles },
  { key: 'shares', label: '用户分享', icon: Link2 },
  { key: 'comments', label: '评论提名', icon: Lightbulb },
  { key: 'llm_usage', label: 'LLM 用量', icon: DollarSign },
  { key: 'users', label: '成员', icon: User },
];

interface DashboardData {
  pendingReviews: { total: number; shares: number; commentNominations: number };
  content: { newResearchesThisWeek: number };
  jobs: { submittedLast24h: number; failedLast24h: number; failedImportJobs: number };
  cost: { monthUsdCents: number; monthUsd: string };
  // ADR 0010: 认知闭环 V2 关键产品事件计数（最近 7 天）
  cognitionLoop: {
    topicResearchStarted: number;
    researchPlanConfirmed: number;
    researchContextReused: number;
    researchDraftOpened: number;
    researchReopenedFromTopic: number;
    topicIssueViewed: number;
    topicViewedWithUnread: number;
    topicFollowed: number;
    topicUnfollowed: number;
  };
  radar: {
    lastSync: null | {
      id: string;
      source: { name: string; sourceType: string } | null;
      status: string;
      completedAt: string | null;
      createdAt: string;
      errorCode: string | null;
    };
    monitor: {
      date: string;
      visibleToday: number;
      failedUniqueItems: number;
      failureRate: {
        failed: number;
        attempted: number;
        percent: number;
        targetPercent: number;
        withinTarget: boolean;
      };
      active: boolean;
      runs: {
        total: number;
        running: number;
        completed: number;
        partial: number;
        failed: number;
        fetched: number;
        new: number;
        skipped: number;
        failedItems: number;
        skipReasons: {
          existing: number;
          ruleNoise: number;
          distilledNoise: number;
          unassessable: number;
          hardVeto: number;
          contentFetchFailed: number;
          conflict: number;
          other: number;
        };
        failures: Array<{ code: string; count: number; sources: string[] }>;
      };
      latest: {
        total: number;
        running: number;
        completed: number;
        partial: number;
        failed: number;
      };
      readingLevels: {
        collection: number;
        deep_read: number;
        skim: number;
        noise: number;
        pending: number;
      };
      pendingEnrichment: number;
      scoreDistribution: Array<{ label: string; min: number; max: number; count: number }>;
      governance: {
        noise: number;
        skipReasons: {
          ruleNoise: number;
          distilledNoise: number;
          unassessable: number;
          hardVeto: number;
          contentFetchFailed: number;
          lowQuality: number;
          pendingScore: number;
          other: number;
        };
      };
      activeSources: Array<{ name: string; sourceType: string; startedAt: string }>;
    };
  };
  generatedAt: string;
}

interface RadarRunStatus {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  triggeredBy: 'cron' | 'admin' | string;
  status: string;
  totalFetched: number;
  totalNew: number;
  totalSkipped: number;
  totalFailed: number;
  skippedExisting: number;
  skippedRuleNoise: number;
  skippedDistilledNoise: number;
  skippedConflict: number;
  candidateCount: number;
  scoredCount: number;
  pendingScoreCount: number;
  enrichedCount: number;
  pendingEnrichmentCount: number;
  elapsedMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface DisplayRadarRun extends RadarRunStatus {
  attemptCount: number;
  historicalFailureCount: number;
  recovered: boolean;
}

interface RadarDiagnosticItem {
  id: string;
  runId: string;
  kind: 'filtered' | 'failed';
  status: 'pending' | 'promoted' | 'dismissed';
  title: string;
  url: string;
  body: string | null;
  reasonCode: string;
  reasonMessage: string | null;
  errorType: string | null;
  errorDomain: string | null;
  distilledTier: string | null;
  promotedSummaryId: string | null;
  resolved: boolean;
  createdAt: string;
  source: { name: string; sourceType: string };
}

interface RadarDiagnosticListResponse {
  items: RadarDiagnosticItem[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  failureRate: {
    failed: number;
    attempted: number;
    percent: number;
    targetPercent: number;
    withinTarget: boolean;
  };
}

interface ShareItem {
  id: string;
  url: string;
  canonicalUrl: string;
  userNote: string | null;
  fetchedTitle: string | null;
  summaryText: string | null;
  fetchErrorCode: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  completedAt: string | null;
  submitter: { id: string; name: string; email: string };
  reviewer: { id: string; name: string } | null;
}

interface ShareListResponse {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  items: ShareItem[];
}

interface CommentItem {
  id: string;
  body: string;
  starCount: number;
  promoteStatus: 'none' | 'nominated' | 'approved' | 'rejected';
  targetType: 'research' | 'summary';
  summary: { id: string; title: string } | null;
  research: { id: string; title: string } | null;
  createdAt: string;
  author: { id: string; name: string; email: string };
}

interface CommentListResponse {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  items: CommentItem[];
}

interface AdminResearchItem {
  id: string;
  type: 'research' | 'knowledge';
  status: 'draft' | 'published' | 'archived';
  title: string;
  body: string;
  tags: string[];
  authorId: string;
  creationMethod: string;
  aiAssisted: boolean;
  publishedAt: string | null;
  featuredAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: { id: string; name: string };
}

interface AdminResearchListResponse {
  items: AdminResearchItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export default function AdminConsole() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <Box sx={[adminRootSx, { mx: 'auto', width: '100%', maxWidth: 1280 }]}>
      <Box component="header" sx={{ mb: 2.5 }}>
        <Typography variant="h1" component="h1" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ShieldCheck size={20} aria-hidden="true" />
          Admin 控制台
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          管理内容质量、监控平台健康度。仅 admin 角色可见。
        </Typography>
      </Box>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList sx={{"width":"100%"}}>
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <TabsTrigger key={t.key} value={t.key} icon={<Icon size={16} aria-hidden="true" />} sx={{"flexShrink":0,"whiteSpace":"nowrap"}}>
                {t.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
        <TabsContent value={tab} sx={{"mt":1.5,"& > :not(style) ~ :not(style)":{"marginTop":1.5}}}>

      <Box sx={{ mt: 2 }}>
        {tab === 'dashboard' && <DashboardTab />}
        {tab === 'radar' && <RadarGovernanceTab />}
        {tab === 'researches' && <ResearchesTab />}
        {tab === 'topics' && (
          <Box component="div" sx={{"& > :not(style) ~ :not(style)":{"marginTop":2}}}>
            <Paper variant="outlined" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, p: 2 }}>
              <div>
                <Typography variant="subtitle2">主题运营</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                  主题提议在下方审核队列生成并审核；这里仅负责对已发布主题生成 AI 综述。
                </Typography>
              </div>
              <AdminTopicActions />
            </Paper>
            <TopicProposalsTab />
          </Box>
        )}
        {tab === 'shares' && <SharesTab />}
        {tab === 'comments' && <CommentsTab />}
        {tab === 'llm_usage' && <LlmUsageConsole />}
        {tab === 'users' && <UsersTab />}
      </Box>
        </TabsContent>
      </Tabs>
    </Box>
  );
}

/** 队列筛选胶囊组 —— 三个 tab 页共用。 */
function FilterPills<T extends string>({
  options,
  value,
  onChange,
  trailing,
}: {
  options: ReadonlyArray<{ key: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <Box component="div" sx={{"mb":1.5,"display":"flex","flexWrap":"wrap","alignItems":"center","gap":0.5}}>
      {options.map((o) => (
        <Button
          key={o.key}
          type="button"
          variant={value === o.key ? 'default' : 'outline'}
          size="xs"
          sx={{"borderRadius":"var(--dr-radius-pill)"}}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </Button>
      ))}
      {trailing ? (
        <Box component="div" sx={{"ml":"auto","fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>{trailing}</Box>
      ) : null}
    </Box>
  );
}

function QueueSkeleton() {
  return (
    <Box component="div" sx={{"display":"grid","gap":1}}>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} sx={{"height":64,"width":"100%"}} />
      ))}
    </Box>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 仪表板
// ──────────────────────────────────────────────────────────────────────

function DashboardTab() {
  const queryClient = useQueryClient();
  const [radarActionMessage, setRadarActionMessage] = useState('');
  const [radarDate, setRadarDate] = useState(() => shanghaiDateValue());
  const [runFilter, setRunFilter] = useState<'all' | 'attention' | 'new'>('all');
  const [failureRunId, setFailureRunId] = useState<string | null>(null);
  const q = useQuery<DashboardData>({
    queryKey: ['admin-dashboard'],
    queryFn: async () => {
      const r = await fetch('/api/admin/dashboard', { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
    refetchInterval: 5_000,
  });
  const runsQ = useQuery<RadarRunStatus[]>({
    queryKey: ['admin-radar-runs', radarDate],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: '200', date: radarDate });
      const r = await fetch(`/api/admin/radar/runs?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('加载逐源同步状态失败');
      return r.json();
    },
    refetchInterval: 30_000,
  });
  const syncMut = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/admin/radar/sync', { method: 'POST' });
      if (response.status === 409) {
        throw new Error('已有同步任务进行中，请等待完成后再试');
      }
      if (!response.ok) throw new Error('同步任务提交失败');
      return response.json();
    },
    onSuccess: () => {
      setRadarActionMessage('雷达同步已提交，完成后会刷新候选和主题状态');
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['admin-radar-runs'] });
    },
    onError: (error) => {
      setRadarActionMessage((error as Error).message);
    },
  });
  const retrySourceMut = useMutation({
    mutationFn: async (runId: string) => {
      const response = await fetch(`/api/admin/radar/runs/${runId}/retry`, { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: '来源重跑失败' }));
        throw new Error((body as { message?: string }).message ?? '来源重跑失败');
      }
      return response.json();
    },
    onSuccess: () => {
      setRadarActionMessage('来源级重跑已提交');
      queryClient.invalidateQueries({ queryKey: ['admin-radar-runs'] });
    },
    onError: (error) => setRadarActionMessage((error as Error).message),
  });

  const syncInFlight = q.data?.radar.lastSync?.status === 'running';
  const latestRuns = useMemo(() => {
    const latest = new Map<string, RadarRunStatus>();
    for (const run of runsQ.data ?? []) {
      if (!latest.has(run.sourceId)) latest.set(run.sourceId, run);
    }
    return [...latest.values()];
  }, [runsQ.data]);
  const runSummary = useMemo(() => ({
    completed: latestRuns.filter((run) => run.status === 'completed').length,
    partial: latestRuns.filter((run) => run.status === 'partial').length,
    failed: latestRuns.filter((run) => run.status === 'failed').length,
    running: latestRuns.filter((run) => run.status === 'running').length,
    totalNew: latestRuns.reduce((sum, run) => sum + run.totalNew, 0),
    pendingScore: latestRuns.reduce((sum, run) => sum + run.pendingScoreCount, 0),
    pendingEnrichment: latestRuns.reduce(
      (sum, run) => sum + run.pendingEnrichmentCount,
      0,
    ),
  }), [latestRuns]);
  const dailyNewBySource = useMemo(() => {
    const totals = new Map<string, number>();
    for (const run of runsQ.data ?? []) {
      totals.set(run.sourceId, (totals.get(run.sourceId) ?? 0) + run.totalNew);
    }
    return totals;
  }, [runsQ.data]);
  const displayRuns = useMemo<DisplayRadarRun[]>(() => {
    const history = new Map<string, { attempts: number; failures: number }>();
    for (const run of runsQ.data ?? []) {
      const current = history.get(run.sourceId) ?? { attempts: 0, failures: 0 };
      current.attempts += 1;
      if (run.status === 'failed' || run.status === 'partial') current.failures += 1;
      history.set(run.sourceId, current);
    }
    return latestRuns.map((run) => {
      const sourceHistory = history.get(run.sourceId) ?? { attempts: 1, failures: 0 };
      return {
        ...run,
        // The row represents the source's latest status, but its +N is the
        // full selected-day total so the visible rows add up to dailyNew.
        totalNew: dailyNewBySource.get(run.sourceId) ?? 0,
        attemptCount: sourceHistory.attempts,
        historicalFailureCount: sourceHistory.failures,
        recovered: run.status === 'completed' && sourceHistory.failures > 0,
      };
    });
  }, [dailyNewBySource, latestRuns, runsQ.data]);
  const dailyNew = useMemo(
    () => (runsQ.data ?? []).reduce((sum, run) => sum + run.totalNew, 0),
    [runsQ.data],
  );
  const sortedRuns = useMemo(() => {
    const statusRank: Record<string, number> = {
      running: 0,
      failed: 1,
      partial: 2,
      completed: 3,
    };
    return [...displayRuns].sort((a, b) => {
      const statusDelta = (statusRank[a.status] ?? 4) - (statusRank[b.status] ?? 4);
      if (statusDelta !== 0) return statusDelta;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [displayRuns]);
  const visibleRuns = useMemo(() => sortedRuns.filter((run) => {
    if (runFilter === 'attention') {
      return run.status === 'running' || run.status === 'partial' || run.status === 'failed';
    }
    if (runFilter === 'new') return run.totalNew > 0;
    return true;
  }), [runFilter, sortedRuns]);
  const attentionCount = runSummary.running + runSummary.partial + runSummary.failed;
  const recoveredCount = displayRuns.filter((run) => run.recovered).length;

  if (q.isLoading) {
    return (
      <Box component="div" sx={{"display":"grid","gap":1.5,"@media (min-width:640px)":{"gridTemplateColumns":"repeat(2, minmax(0, 1fr))"},"@media (min-width:1280px)":{"gridTemplateColumns":"repeat(4, minmax(0, 1fr))"}}}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} sx={{"height":80,"width":"100%"}} />
        ))}
      </Box>
    );
  }
  if (q.isError || !q.data) {
    return <Box component="p" sx={{"fontSize":"var(--dr-type-body)","color":"error.main"}}>{(q.error as Error)?.message ?? '加载失败'}</Box>;
  }

  const d = q.data;

  return (
    <div>
      <Box component="section" sx={{"mb":2,"overflow":"hidden","borderRadius":"var(--dr-radius-small)","border":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"background.paper"}}>
        <Box component="div" sx={{"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","px":2,"py":1.5}}>
          <Box component="div" sx={{"display":"flex","flexWrap":"wrap","alignItems":"center","justifyContent":"space-between","gap":1}}>
            <div>
              <Box component="h2" sx={{"display":"flex","alignItems":"center","gap":1,"fontSize":"var(--dr-type-title-small)","fontWeight":"var(--dr-weight-semibold)"}}>
                <Box component={CircleAlert} sx={{"width":16,"height":16,"color":"primary.main"}} />
                异常优先
              </Box>
              <Box component="p" sx={{"mt":0.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>先处理会阻塞内容质量和研究交付的事项。</Box>
            </div>
            <Box component="span" sx={{"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
              仪表板每 5 秒刷新
            </Box>
          </Box>
        </Box>
        <Box component="div" sx={{"display":"grid","gridTemplateColumns":"repeat(2, minmax(0, 1fr))","gap":0.125,"backgroundColor":"divider","@media (min-width:640px)":{"gridTemplateColumns":"repeat(3, minmax(0, 1fr))"},"@media (min-width:1280px)":{"gridTemplateColumns":"repeat(5, minmax(0, 1fr))"}}}>
        <StatCard
          label={
            <Box component="span" sx={{"display":"inline-flex","alignItems":"center","gap":0.5}}>
              <Box component={CircleAlert} sx={{"width":12,"height":12}} />
              今日异常
            </Box>
          }
          value={
            d.pendingReviews.total
            + d.jobs.failedLast24h
            + d.jobs.failedImportJobs
            + d.radar.monitor.latest.failed
            + d.radar.monitor.latest.partial
          }
          hint={`雷达失败 ${d.radar.monitor.latest.failed + d.radar.monitor.latest.partial} · AI 失败 ${d.jobs.failedLast24h}`}
          tone="primary"
          variant="grid" density="compact"
        />
        <StatCard
          label={
            <Box component="span" sx={{"display":"inline-flex","alignItems":"center","gap":0.5}}>
              <Box component={Timer} sx={{"width":12,"height":12}} />
              待处理
            </Box>
          }
          value={d.pendingReviews.total}
          hint={
            <span>
              分享 {d.pendingReviews.shares} · 待提炼 {d.pendingReviews.commentNominations}
            </span>
          }
          tone={d.pendingReviews.total > 0 ? 'primary' : 'default'}
          variant="grid" density="compact"
        />
        <StatCard
          label={
            <Box component="span" sx={{"display":"inline-flex","alignItems":"center","gap":0.5}}>
              <Box component={RadarIcon} sx={{"width":12,"height":12}} />
              雷达待治理
            </Box>
          }
          value={d.radar.monitor.failedUniqueItems}
          hint={`待评分 ${d.radar.monitor.readingLevels.pending} · 待补全 ${d.radar.monitor.pendingEnrichment}`}
          tone={d.radar.monitor.failedUniqueItems > 0 ? 'primary' : 'default'}
          variant="grid" density="compact"
        />
        <StatCard
          label={
            <Box component="span" sx={{"display":"inline-flex","alignItems":"center","gap":0.5}}>
              <Box component={Sparkles} sx={{"width":12,"height":12}} />
              AI 调研失败
            </Box>
          }
          value={d.jobs.failedLast24h + d.jobs.failedImportJobs}
          hint={`过去 24h 提交 ${d.jobs.submittedLast24h}`}
          tone={d.jobs.failedLast24h + d.jobs.failedImportJobs > 0 ? 'primary' : 'default'}
          variant="grid" density="compact"
        />
        <StatCard
          label={
            <Box component="span" sx={{"display":"inline-flex","alignItems":"center","gap":0.5}}>
              <Box component={DollarSign} sx={{"width":12,"height":12}} />
              本月 AI 成本
            </Box>
          }
          value={`$${d.cost.monthUsd}`}
          hint="用于观察成本异常，趋势见用量页"
          variant="grid" density="compact" sx={{"gridColumn":"span 2 / span 2","@media (min-width:1280px)":{"gridColumn":"span 1 / span 1"}}}
        />
      </Box>
      </Box>

      <Box data-admin-hover-group="true" component="details" sx={{"mb":2,"borderRadius":"var(--dr-radius-small)","border":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"color-mix(in srgb, var(--dr-color-surface) 50%, var(--dr-color-surface-container))"}}>
        <Box component="summary" sx={{"display":"flex","cursor":"pointer","listStyle":"none","alignItems":"center","justifyContent":"space-between","gap":1.5,"px":2,"py":1.5,"fontSize":"var(--dr-type-body)","fontWeight":"var(--dr-weight-semibold)","&::-webkit-details-marker":{"display":"none"}}}>
          <Box component="span" sx={{"display":"flex","alignItems":"center","gap":1}}><Box component={Sparkles} sx={{"width":16,"height":16,"color":"primary.main"}} />认知闭环 V2 · 近 7 天</Box>
          <Box component={ChevronDown} sx={{"width":16,"height":16,"color":"text.secondary","transition":"transform var(--dr-motion-fast)","details[open] &":{"transform":"rotate(180deg)"}}} aria-hidden />
        </Box>
        <Box component="div" sx={{"borderTop":"1px solid var(--dr-color-outline)","borderColor":"divider","p":1.5}}>
        <Box component="div" sx={{"display":"grid","gridTemplateColumns":"repeat(2, minmax(0, 1fr))","gap":1,"@media (min-width:640px)":{"gridTemplateColumns":"repeat(3, minmax(0, 1fr))"},"@media (min-width:1024px)":{"gridTemplateColumns":"repeat(5, minmax(0, 1fr))"}}}>
          <StatCard
            label={<span>专题被关注</span>}
            value={d.cognitionLoop.topicFollowed}
            hint={`取消 ${d.cognitionLoop.topicUnfollowed}`}
            tone="primary"
            density="dense"
          />
          <StatCard
            label={<span>专题深度查看</span>}
            value={d.cognitionLoop.topicViewedWithUnread}
            hint="含未读议题时"
            tone={d.cognitionLoop.topicViewedWithUnread > 0 ? 'primary' : 'default'}
            density="dense"
          />
          <StatCard
            label={<span>专题发起调研</span>}
            value={d.cognitionLoop.topicResearchStarted}
            tone="primary"
            density="dense"
          />
          <StatCard
            label={<span>确认研究计划</span>}
            value={d.cognitionLoop.researchPlanConfirmed}
            hint={
              d.cognitionLoop.topicResearchStarted > 0
                ? `${Math.round(
                    (d.cognitionLoop.researchPlanConfirmed /
                      Math.max(1, d.cognitionLoop.topicResearchStarted)) *
                      100,
                  )}% 转化`
                : '尚无样本'
            }
            density="dense"
          />
          <StatCard
            label={<span>复用上下文</span>}
            value={d.cognitionLoop.researchContextReused}
            hint="研究复用了历史上下文的次数"
            tone={d.cognitionLoop.researchContextReused > 0 ? 'primary' : 'default'}
            density="dense"
          />
        </Box>
      </Box>
      </Box>

      <Box data-admin-hover-group="true" component="details" sx={{"mb":2,"overflow":"hidden","borderRadius":"var(--dr-radius-small)","border":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"background.paper"}}>
        <Box component="summary" sx={{"display":"flex","cursor":"pointer","listStyle":"none","alignItems":"center","justifyContent":"space-between","gap":1.5,"px":2,"py":1.5,"fontSize":"var(--dr-type-body)","fontWeight":"var(--dr-weight-semibold)","&::-webkit-details-marker":{"display":"none"}}}>
          <Box component="span" sx={{"display":"flex","alignItems":"center","gap":1}}><Box component={RadarIcon} sx={{"width":16,"height":16,"color":"text.secondary"}} />雷达运行明细</Box>
          <Box component="span" sx={{"display":"flex","alignItems":"center","gap":1,"fontSize":"var(--dr-type-caption)","fontWeight":"var(--dr-weight-regular)","color":"text.secondary"}}>
            异常 {attentionCount} · 进入后查看逐源状态
            <Box component={ChevronDown} sx={{"width":16,"height":16,"transition":"transform var(--dr-motion-fast)","details[open] &":{"transform":"rotate(180deg)"}}} aria-hidden />
          </Box>
        </Box>
        <Box component="div" sx={{"borderTop":"1px solid var(--dr-color-outline)","borderColor":"divider","p":1.5}}>
      <RadarMonitorPanel monitor={d.radar.monitor} generatedAt={d.generatedAt} />
      <RadarScoringRules />

      <Box component="section" sx={{"overflow":"hidden","borderRadius":"var(--dr-radius-small)","border":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"background.paper"}}>
        <Box component="div" sx={{"display":"flex","flexWrap":"wrap","alignItems":"flex-start","justifyContent":"space-between","gap":1.5,"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","px":2,"py":1.5}}>
          <div>
            <Box component="div" sx={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":1}}>
              <Box component="h2" sx={{"display":"flex","alignItems":"center","gap":1,"fontSize":"var(--dr-type-title-small)","fontWeight":"var(--dr-weight-semibold)"}}>
                <Box component={RadarIcon} sx={{"width":16,"height":16,"color":"text.secondary"}} />
                雷达同步
              </Box>
              <RadarHealthBadge
                running={runSummary.running}
                failed={runSummary.failed}
                partial={runSummary.partial}
                pending={runSummary.pendingScore + runSummary.pendingEnrichment}
              />
            </Box>
            <Box component="p" sx={{"mt":0.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
              同步、评分与内容补全的逐源运行状态
            </Box>
          </div>
          <Box component="div" sx={{"display":"grid","width":"100%","gridTemplateColumns":"repeat(2, minmax(0, 1fr))","alignItems":"flex-end","gap":1,"@media (min-width:640px)":{"display":"flex","width":"auto","flexWrap":"wrap","justifyContent":"flex-end"}}}>
            <Box component="label" sx={{"gridColumn":"span 2 / span 2","display":"grid","gap":0.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary","@media (min-width:640px)":{"gridColumn":"span 1 / span 1"}}}>
              <Box component="span" sx={{"display":"inline-flex","alignItems":"center","gap":0.5}}>
                <Box component={CalendarDays} sx={{"width":14,"height":14}} />
                查看日期
              </Box>
              <Input
                type="date"
                value={radarDate}
                max={shanghaiDateValue()}
                sx={{"height":32,"width":"100%","fontSize":"var(--dr-type-caption)","@media (min-width:640px)":{"width":148}}}
                onChange={(event) => {
                  setRadarDate(event.target.value || shanghaiDateValue());
                  setRunFilter('all');
                }}
              />
            </Box>
            <Button
              type="button"
              size="sm"
              sx={{"width":"100%","@media (min-width:640px)":{"width":"auto"}}}
              disabled={syncMut.isPending || syncInFlight}
              onClick={() => syncMut.mutate()}
            >
              <Box component={RefreshCw} sx={[{"width":16,"height":16}, syncMut.isPending && {"animation":"adminSpin 1s linear infinite"}]} />
              启动今日同步
            </Button>
          </Box>
        </Box>
        {radarActionMessage ? (
          <Box component="p" sx={{"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","px":2,"py":1,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}} aria-live="polite">
            {radarActionMessage}
          </Box>
        ) : null}
        {syncInFlight ? (
          <Box component="div"
            sx={{"display":"flex","alignItems":"center","gap":1,"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"color-mix(in srgb, var(--dr-color-primary) 20%, var(--dr-color-outline))","backgroundColor":"color-mix(in srgb, var(--dr-color-primary-container) 50%, var(--dr-color-surface))","px":2,"py":1,"fontSize":"var(--dr-type-caption)","color":"primary.main"}}
            aria-live="polite"
          >
            <Box component={LoaderCircle} sx={{"width":14,"height":14,"animation":"adminSpin 1s linear infinite"}} />
            当前同步正在运行，完成后会自动刷新候选和主题状态。
          </Box>
        ) : null}
        {runsQ.isLoading ? (
          <Box component="div" sx={{"display":"grid","gap":1,"p":2}}>
            {[0, 1, 2].map((i) => <Skeleton key={i} sx={{"height":48,"width":"100%"}} />)}
          </Box>
        ) : runsQ.isError ? (
          <Box component="p" sx={{"p":2,"fontSize":"var(--dr-type-body)","color":"error.main"}}>{(runsQ.error as Error).message}</Box>
        ) : latestRuns.length === 0 ? (
          <Box component="p" sx={{"p":2,"fontSize":"var(--dr-type-body)","color":"text.secondary"}}>该日期暂无同步记录</Box>
        ) : (
          <>
            <Box component="div" sx={{"display":"grid","gridTemplateColumns":"repeat(2, minmax(0, 1fr))","borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"color-mix(in srgb, var(--dr-color-surface-container) 20%, var(--dr-color-surface))","@media (min-width:640px)":{"gridTemplateColumns":"repeat(3, minmax(0, 1fr))"},"@media (min-width:1280px)":{"gridTemplateColumns":"repeat(6, minmax(0, 1fr))"}}}>
              <RadarMetric label="信息源" value={latestRuns.length} />
              <RadarMetric label="完成" value={runSummary.completed} tone="success" />
              <RadarMetric label="当前异常" value={attentionCount} tone={attentionCount > 0 ? 'danger' : 'default'} />
              <RadarMetric label="今日新增" value={`+${dailyNew}`} tone="success" />
              <RadarMetric label="待评分" value={runSummary.pendingScore} tone={runSummary.pendingScore > 0 ? 'warning' : 'default'} />
              <RadarMetric label="待补全" value={runSummary.pendingEnrichment} tone={runSummary.pendingEnrichment > 0 ? 'warning' : 'default'} />
            </Box>

            <Box component="div" sx={{"display":"flex","flexWrap":"wrap","alignItems":"center","justifyContent":"space-between","gap":1,"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","px":2,"py":1}}>
              <Box component="div" sx={{"display":"inline-flex","overflow":"hidden","borderRadius":"var(--dr-radius-small)","border":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"background.paper"}}>
                {([
                  ['all', `全部 ${latestRuns.length}`],
                  ['attention', `异常 ${attentionCount}`],
                    ['new', `有新增 ${displayRuns.filter((run) => run.totalNew > 0).length}`],
                ] as const).map(([key, label]) => (
                  <Box component="button"
                    key={key}
                    type="button"
                    aria-pressed={runFilter === key}
                    sx={[{"height":28,"borderRight":"1px solid var(--dr-color-outline)","borderColor":"divider","px":1.5,"fontSize":"var(--dr-type-caption)","transition":"color, background-color, border-color var(--dr-motion-fast)","&:last-of-type":{"borderRightWidth":0}}, runFilter === key ? {"backgroundColor":"text.primary","fontWeight":"var(--dr-weight-medium)","color":"background.paper"} : {"color":"text.secondary","&:hover":{"backgroundColor":"action.hover","color":"text.primary"}}]}
                    onClick={() => setRunFilter(key)}
                  >
                    {label}
                  </Box>
                ))}
              </Box>
              <Box component="span" sx={{"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
                {visibleRuns.length} 个结果 · 每个来源显示最近一次运行
                {recoveredCount > 0 ? ` · ${recoveredCount} 个来源已恢复` : ''}
              </Box>
            </Box>

            <Box component="div" sx={{"display":"none","overflowX":"auto","@media (min-width:768px)":{"display":"block"}}}>
              <Box component="table" sx={{"width":"100%","minWidth":980,"textAlign":"left","fontSize":"var(--dr-type-caption)"}}>
                <Box component="thead" sx={{"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"color-mix(in srgb, var(--dr-color-surface-container) 10%, var(--dr-color-surface))","color":"text.secondary"}}>
                  <tr>
                    <Box component="th" sx={{"px":2,"py":1,"fontWeight":"var(--dr-weight-medium)"}}>信息源</Box>
                    <Box component="th" sx={{"px":1.5,"py":1,"fontWeight":"var(--dr-weight-medium)"}}>状态</Box>
                    <Box component="th" sx={{"px":1.5,"py":1,"fontWeight":"var(--dr-weight-medium)"}}>同步结果</Box>
                    <Box component="th" sx={{"px":1.5,"py":1,"fontWeight":"var(--dr-weight-medium)"}}>后处理</Box>
                    <Box component="th" sx={{"px":2,"py":1,"fontWeight":"var(--dr-weight-medium)"}}>耗时 / 问题</Box>
                    <Box component="th" sx={{"px":1.5,"py":1,"fontWeight":"var(--dr-weight-medium)"}}>操作</Box>
                  </tr>
                </Box>
                <Box component="tbody" sx={{"& > :not(:last-child)":{"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"var(--dr-color-outline)"}}}>
                  {visibleRuns.map((run) => (
                    <Fragment key={run.sourceId}>
                      <Box component="tr"
                        sx={[{"verticalAlign":"middle","transition":"color, background-color, border-color var(--dr-motion-fast)","&:hover":{"backgroundColor":"color-mix(in srgb, var(--dr-color-surface-container) 20%, var(--dr-color-surface))"}}, run.status === 'failed' && {"backgroundColor":"color-mix(in srgb, var(--dr-color-danger) 4%, var(--dr-color-surface))"}, run.status === 'partial' && {"backgroundColor":"var(--dr-color-warning-container)"}]}
                      >
                      <Box component="td" sx={{"px":2,"py":1.5}}>
                        <Box component="div" sx={{"fontWeight":"var(--dr-weight-medium)","color":"text.primary"}}>{run.sourceName}</Box>
                        <Box component="div" sx={{"mt":0.5,"display":"flex","alignItems":"center","gap":1,"color":"text.secondary"}}>
                          <span>{formatSourceType(run.sourceType).short}</span>
                          <span aria-hidden="true">·</span>
                          <span>{run.triggeredBy === 'cron' ? '定时' : '手动'}</span>
                        </Box>
                      </Box>
                      <Box component="td" sx={{"px":1.5,"py":1.5}}>
                        <SyncStatusBadge status={run.status} />
                        {run.recovered ? (
                          <Box component="div" sx={[{"mt":0.5,"fontSize":"var(--dr-type-caption)","fontWeight":"var(--dr-weight-medium)"}, {"color":"success.main"}]}>
                            已恢复 · 历史失败 {run.historicalFailureCount} 次
                          </Box>
                        ) : run.attemptCount > 1 ? (
                          <Box component="div" sx={{"mt":0.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
                            第 {run.attemptCount} 次运行
                          </Box>
                        ) : null}
                        <Box component="div" sx={{"mt":0.5,"fontFamily":"monospace","fontSize":"var(--dr-type-caption)","fontVariantNumeric":"tabular-nums","color":"text.secondary"}}>
                          {formatRunTime(run.completedAt ?? run.createdAt)}
                        </Box>
                      </Box>
                      <Box component="td" sx={{"px":1.5,"py":1.5}}>
                        <Box component="div" sx={{"fontFamily":"monospace","fontVariantNumeric":"tabular-nums","color":"text.primary"}}>
                          {run.totalFetched}
                          <Box component="span" sx={{"ml":0.5,"fontFamily":"var(--dr-font-family)","color":"text.secondary"}}>抓取</Box>
                          <Box component="span" sx={[{"ml":1}, {"color":"success.main"}]}>+{run.totalNew}</Box>
                        </Box>
                        {run.totalFailed > 0 ? (
                          <Box component="div" sx={{"mt":0.5,"color":"error.main"}}>失败 {run.totalFailed}</Box>
                        ) : (
                          <Box component="div" sx={{"mt":0.5,"color":"text.secondary"}}>跳过 {run.totalSkipped}</Box>
                        )}
                      </Box>
                      <Box component="td" sx={{"width":210,"px":1.5,"py":1.5}}>
                        <PipelineMetric
                          label="评分"
                          completed={run.scoredCount}
                          total={run.candidateCount}
                          pending={run.pendingScoreCount}
                        />
                        <PipelineMetric
                          label="补全"
                          completed={run.enrichedCount}
                          total={run.candidateCount}
                          pending={run.pendingEnrichmentCount}
                        />
                      </Box>
                      <Box component="td" sx={{"maxWidth":240,"px":2,"py":1.5,"color":"text.secondary"}}>
                        <Box component="div" sx={{"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>{formatElapsed(run.elapsedMs)}</Box>
                        {run.errorCode ? (
                          <Box component="div" sx={{"mt":0.5,"whiteSpace":"normal","overflowWrap":"anywhere","fontSize":"var(--dr-type-caption)","color":"error.main"}}>
                            <code>{run.errorCode}</code>
                            {run.errorMessage ? <Box component="div" sx={{"mt":0.5,"fontFamily":"var(--dr-font-family)"}}>{run.errorMessage}</Box> : null}
                          </Box>
                        ) : null}
                      </Box>
                      <Box component="td" sx={{"px":1.5,"py":1.5}}>
                        <Box component="div" sx={{"display":"flex","alignItems":"center","gap":0.5}}>
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            title="重跑此来源"
                            aria-label={`重跑${run.sourceName}`}
                            disabled={retrySourceMut.isPending || syncMut.isPending || syncInFlight}
                            onClick={() => retrySourceMut.mutate(run.id)}
                          >
                            <Box component={Play} sx={{"width":14,"height":14}} />
                            重跑
                          </Button>
                          {run.totalFailed > 0 ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              title="查看失败条目"
                              aria-label={`查看${run.sourceName}失败条目`}
                              onClick={() => setFailureRunId(failureRunId === run.id ? null : run.id)}
                            >
                              <Box component={FileWarning} sx={{"width":14,"height":14}} />
                            </Button>
                          ) : null}
                        </Box>
                      </Box>
                      </Box>
                      {failureRunId === run.id ? (
                        <tr>
                          <Box component="td" colSpan={6} sx={{"p":0}}>
                            <RunFailureDetails runId={run.id} sourceName={run.sourceName} />
                          </Box>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </Box>
              </Box>
            </Box>

            <Box component="div" sx={{"& > :not(:last-child)":{"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"var(--dr-color-outline)"},"@media (min-width:768px)":{"display":"none"}}}>
              {visibleRuns.map((run) => (
                <Box component="div"
                  key={run.sourceId}
                  sx={[{"px":2,"py":1.5}, run.status === 'failed' && {"backgroundColor":"color-mix(in srgb, var(--dr-color-danger) 4%, var(--dr-color-surface))"}, run.status === 'partial' && {"backgroundColor":"var(--dr-color-warning-container)"}]}
                >
                  <Box component="div" sx={{"display":"flex","alignItems":"flex-start","justifyContent":"space-between","gap":1.5}}>
                    <Box component="div" sx={{"minWidth":0}}>
                      <Box component="div" sx={{"overflow":"hidden","textOverflow":"ellipsis","whiteSpace":"nowrap","fontSize":"var(--dr-type-body)","fontWeight":"var(--dr-weight-medium)","color":"text.primary"}}>{run.sourceName}</Box>
                      <Box component="div" sx={{"mt":0.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
                        {formatSourceType(run.sourceType).short} · {run.triggeredBy === 'cron' ? '定时' : '手动'} · {formatRunTime(run.completedAt ?? run.createdAt)}
                      </Box>
                    </Box>
                    <Box component="div" sx={{"textAlign":"right"}}>
                      <SyncStatusBadge status={run.status} />
                      {run.recovered ? (
                        <Box component="div" sx={[{"mt":0.5,"fontSize":"var(--dr-type-caption)","fontWeight":"var(--dr-weight-medium)"}, {"color":"success.main"}]}>
                          已恢复 · 失败 {run.historicalFailureCount} 次
                        </Box>
                      ) : null}
                    </Box>
                  </Box>
                  <Box component="div" sx={{"mt":1.5,"display":"grid","gridTemplateColumns":"repeat(3, minmax(0, 1fr))","gap":1.5,"fontSize":"var(--dr-type-caption)"}}>
                    <div>
                      <Box component="div" sx={{"color":"text.secondary"}}>同步</Box>
                      <Box component="div" sx={{"mt":0.5,"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>
                        {run.totalFetched} / <Box component="span" sx={{"color":"success.main"}}>+{run.totalNew}</Box>
                      </Box>
                    </div>
                    <div>
                      <Box component="div" sx={{"color":"text.secondary"}}>评分</Box>
                      <Box component="div" sx={{"mt":0.5,"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>{stageCount(run.scoredCount, run.candidateCount)}</Box>
                    </div>
                    <div>
                      <Box component="div" sx={{"color":"text.secondary"}}>补全</Box>
                      <Box component="div" sx={{"mt":0.5,"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>{stageCount(run.enrichedCount, run.candidateCount)}</Box>
                    </div>
                  </Box>
                  {run.errorCode ? (
                    <Box component="div" sx={{"mt":1,"overflowWrap":"anywhere","fontSize":"var(--dr-type-caption)","color":"error.main"}}>
                      <code>{run.errorCode}</code>
                      {run.errorMessage ? <Box component="div" sx={{"mt":0.5,"fontSize":"var(--dr-type-caption)"}}>{run.errorMessage}</Box> : null}
                    </Box>
                  ) : null}
                  <Box component="div" sx={{"mt":1,"display":"flex","flexWrap":"wrap","gap":1}}>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={retrySourceMut.isPending || syncMut.isPending || syncInFlight}
                      onClick={() => retrySourceMut.mutate(run.id)}
                    >
                      <Play />
                      重跑
                    </Button>
                    {run.totalFailed > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => setFailureRunId(failureRunId === run.id ? null : run.id)}
                      >
                        <FileWarning />
                        查看失败条目
                      </Button>
                    ) : null}
                  </Box>
                  {failureRunId === run.id ? <RunFailureDetails runId={run.id} sourceName={run.sourceName} /> : null}
                </Box>
              ))}
            </Box>
          </>
        )}
      </Box>
        </Box>
      </Box>

      <Box component="p" sx={{"mt":2,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
        数据生成时间：{new Date(d.generatedAt).toLocaleString('zh-CN')} · 仪表板每 5 秒、逐源明细每 30 秒自动刷新
      </Box>
    </div>
  );
}

function RadarMonitorPanel({
  monitor,
  generatedAt,
}: {
  monitor: DashboardData['radar']['monitor'];
  generatedAt: string;
}) {
  const levelTotal = Object.values(monitor.readingLevels).reduce((sum, count) => sum + count, 0);
  const scoreTotal = monitor.scoreDistribution.reduce((sum, bucket) => sum + bucket.count, 0);
  const completedRuns = monitor.latest.completed + monitor.latest.partial + monitor.latest.failed;
  const runProgress = monitor.latest.total > 0
    ? Math.round((completedRuns / monitor.latest.total) * 100)
    : 0;
  const maxLevel = Math.max(1, ...Object.values(monitor.readingLevels));
  const maxScore = Math.max(1, ...monitor.scoreDistribution.map((bucket) => bucket.count));

  return (
    <Box component="section" sx={{"mb":2,"overflow":"hidden","borderRadius":"var(--dr-radius-small)","border":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"background.paper"}}>
      <Box component="div" sx={{"display":"flex","flexWrap":"wrap","alignItems":"flex-start","justifyContent":"space-between","gap":1.5,"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","px":2,"py":1.5}}>
        <div>
          <Box component="div" sx={{"display":"flex","alignItems":"center","gap":1}}>
            <Box component="h2" sx={{"display":"flex","alignItems":"center","gap":1,"fontSize":"var(--dr-type-title-small)","fontWeight":"var(--dr-weight-semibold)"}}>
              <Box component={Activity} sx={{"width":16,"height":16,"color":"text.secondary"}} />
              雷达实时监控
            </Box>
            <Box component="span"
              sx={[{"display":"inline-flex","alignItems":"center","gap":0.5,"borderRadius":"var(--dr-radius-pill)","px":1,"py":0.5,"fontSize":"var(--dr-type-caption)","fontWeight":"var(--dr-weight-medium)"}, monitor.active ? {"backgroundColor":"var(--dr-color-primary-container)","color":"primary.main"} : {"backgroundColor":"var(--dr-color-success-container)","color":"success.main"}]}
            >
              <Box component="span" sx={[{"width":6,"height":6,"borderRadius":"var(--dr-radius-pill)","backgroundColor":"currentColor"}, monitor.active && {"animation":"adminPulse 1.5s ease-in-out infinite"}]} />
              {monitor.active ? '同步进行中' : '当前无运行任务'}
            </Box>
          </Box>
          <Box component="p" sx={{"mt":0.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
            今日 {monitor.date} · 数据更新时间 {new Date(generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}
          </Box>
        </div>
        {monitor.activeSources.length > 0 ? (
          <Box component="div" sx={{"display":"flex","maxWidth":"100%","flexWrap":"wrap","alignItems":"center","justifyContent":"flex-end","gap":1,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
            <span>正在处理：</span>
            {monitor.activeSources.slice(0, 4).map((source) => (
              <Badge key={`${source.name}-${source.startedAt}`} variant="secondary">{source.name}</Badge>
            ))}
            {monitor.activeSources.length > 4 ? <span>+{monitor.activeSources.length - 4}</span> : null}
          </Box>
        ) : null}
      </Box>

      <Box component="div" sx={{"display":"grid","gridTemplateColumns":"repeat(2, minmax(0, 1fr))","borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"color-mix(in srgb, var(--dr-color-surface-container) 20%, var(--dr-color-surface))","@media (min-width:640px)":{"gridTemplateColumns":"repeat(3, minmax(0, 1fr))"},"@media (min-width:1280px)":{"gridTemplateColumns":"repeat(6, minmax(0, 1fr))"}}}>
        <RadarMetric label="来源数" value={monitor.latest.total} />
        <RadarMetric label="完成" value={monitor.latest.completed} tone="success" />
        <RadarMetric
          label="异常来源"
          value={monitor.latest.partial + monitor.latest.failed}
          tone={monitor.latest.partial + monitor.latest.failed > 0 ? 'warning' : 'default'}
        />
        <RadarMetric label="今日写入" value={`+${monitor.runs.new}`} tone="success" />
        <RadarMetric label="今日可见" value={monitor.visibleToday} />
        <RadarMetric label="失败候选" value={monitor.failedUniqueItems} tone={monitor.failedUniqueItems > 0 ? 'danger' : 'default'} />
      </Box>

      <Box component="div" sx={{"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","px":2,"py":1.5}}>
        <Box component="div" sx={{"mb":1,"display":"flex","alignItems":"center","justifyContent":"space-between","gap":1,"fontSize":"var(--dr-type-caption)"}}>
          <Box component="span" sx={{"fontWeight":"var(--dr-weight-semibold)"}}>今日同步进度</Box>
          <Box component="span" sx={{"color":"text.secondary"}}>
            {completedRuns}/{monitor.latest.total} 个来源已结束 · {monitor.runs.total} 次运行
          </Box>
        </Box>
        <Box component="div" sx={{"height":8,"overflow":"hidden","borderRadius":"var(--dr-radius-xs)","backgroundColor":"action.hover"}}>
          <Box component="div"
            sx={[{"height":"100%","width":`${runProgress}%`,"backgroundColor":"success.main","transition":"all var(--dr-motion-fast)"}, monitor.active && {"backgroundColor":"primary.main"}]}
          />
        </Box>
        <Box component="p" sx={{"mt":1,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
          {monitor.latest.completed} 个完成
          {monitor.latest.partial > 0 ? ` · ${monitor.latest.partial} 个部分完成` : ''}
          {monitor.latest.failed > 0 ? ` · ${monitor.latest.failed} 个失败` : ''}
          {monitor.runs.fetched > 0 ? ` · 最近一轮抓取 ${monitor.runs.fetched} 条，跳过 ${monitor.runs.skipped} 条` : ''}
        </Box>
      </Box>

      <Box data-admin-hover-group="true" component="details" sx={{"borderTop":"1px solid var(--dr-color-outline)","borderColor":"divider"}}>
        <Box component="summary" sx={{"display":"flex","cursor":"pointer","listStyle":"none","alignItems":"center","justifyContent":"space-between","gap":1.5,"px":2,"py":1.5,"fontSize":"var(--dr-type-caption)","fontWeight":"var(--dr-weight-semibold)","&::-webkit-details-marker":{"display":"none"}}}>
          <span>查看详细分布与异常原因</span>
          <Box component="span" sx={{"display":"flex","alignItems":"center","gap":1,"fontSize":"var(--dr-type-caption)","fontWeight":"var(--dr-weight-regular)","color":"text.secondary"}}>
            {levelTotal} 条内容 · {monitor.runs.failures.length} 类失败
            <Box component={ChevronDown} sx={{"width":16,"height":16,"transition":"transform var(--dr-motion-fast)","details[open] &":{"transform":"rotate(180deg)"}}} aria-hidden />
          </Box>
        </Box>
        <div>
          <Box component="div" sx={{"display":"grid","gap":0,"& > :not(:last-child)":{"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"var(--dr-color-outline)"},"borderTop":"1px solid var(--dr-color-outline)","borderColor":"divider","@media (min-width:1024px)":{"gridTemplateColumns":"repeat(2, minmax(0, 1fr))","& > :not(:last-child)":{"borderBottomWidth":0}}}}>
            <RadarMonitorSection title="阅读等级分布" hint={`${levelTotal} 条今日写入内容`}>
              <Box component="div" sx={{"& > :not(style) ~ :not(style)":{"marginTop":1}}}>
                {([
                  ['精读', monitor.readingLevels.collection + monitor.readingLevels.deep_read, 'var(--dr-color-tier-deep-read)'],
                  ['速读', monitor.readingLevels.skim, 'var(--dr-color-tier-skim)'],
                  ['不推荐', monitor.readingLevels.noise, 'var(--dr-color-tier-noise)'],
                  ['待评分', monitor.readingLevels.pending, 'var(--dr-color-text-secondary)'],
                ] as const).map(([label, count, color]) => (
                  <Box component="div" key={label} sx={{"display":"grid","gridTemplateColumns":"68px 1fr 30px","alignItems":"center","gap":1,"fontSize":"var(--dr-type-caption)"}}>
                    <Box component="span" sx={{"color":"text.secondary"}}>{label}</Box>
                    <Box component="div" sx={{"height":6,"overflow":"hidden","borderRadius":"var(--dr-radius-xs)","backgroundColor":"action.hover"}}>
                      <Box component="div" sx={{ height: '100%', backgroundColor: color, width: `${(count / maxLevel) * 100}%` }} />
                    </Box>
                    <Box component="span" sx={{"textAlign":"right","fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>{count}</Box>
                  </Box>
                ))}
              </Box>
            </RadarMonitorSection>

            <RadarMonitorSection title="评分分布" hint={`${scoreTotal} 条今日写入内容`}>
              <Box component="div" sx={{"& > :not(style) ~ :not(style)":{"marginTop":1}}}>
                {monitor.scoreDistribution.map((bucket) => (
                  <Box component="div" key={bucket.label} sx={{"display":"grid","gridTemplateColumns":"52px 1fr 30px","alignItems":"center","gap":1,"fontSize":"var(--dr-type-caption)"}}>
                    <Box component="span" sx={{"color":"text.secondary"}}>{bucket.label}</Box>
                    <Box component="div" sx={{"height":6,"overflow":"hidden","borderRadius":"var(--dr-radius-xs)","backgroundColor":"action.hover"}}>
                      <Box component="div" sx={{"height":"100%","width":`${(bucket.count / maxScore) * 100}%`,"backgroundColor":"var(--dr-color-primary)"}} />
                    </Box>
                    <Box component="span" sx={{"textAlign":"right","fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>{bucket.count}</Box>
                  </Box>
                ))}
              </Box>
            </RadarMonitorSection>
          </Box>

          <Box component="div" sx={{"display":"grid","gap":0,"& > :not(:last-child)":{"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"var(--dr-color-outline)"},"borderTop":"1px solid var(--dr-color-outline)","borderColor":"divider","@media (min-width:1024px)":{"gridTemplateColumns":"repeat(2, minmax(0, 1fr))","& > :not(:last-child)":{"borderBottomWidth":0}}}}>
            <RadarMonitorSection title="今日跳过原因（canonicalUrl 去重）">
              <Box component="div" sx={{"display":"flex","flexWrap":"wrap","columnGap":2,"rowGap":0.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
                <span>规则噪声 <Box component="strong" sx={{"fontFamily":"monospace","color":"text.primary"}}>{monitor.governance.skipReasons.ruleNoise}</Box></span>
                <span>评分噪声 <Box component="strong" sx={{"fontFamily":"monospace","color":"text.primary"}}>{monitor.governance.skipReasons.distilledNoise}</Box></span>
                <span>不可评估 <Box component="strong" sx={{"fontFamily":"monospace","color":"text.primary"}}>{monitor.governance.skipReasons.unassessable}</Box></span>
                <span>硬否决 <Box component="strong" sx={{"fontFamily":"monospace","color":"text.primary"}}>{monitor.governance.skipReasons.hardVeto}</Box></span>
                <span>抓取失败 <Box component="strong" sx={{"fontFamily":"monospace","color":"text.primary"}}>{monitor.governance.skipReasons.contentFetchFailed}</Box></span>
                <span>内容不足 <Box component="strong" sx={{"fontFamily":"monospace","color":"text.primary"}}>{monitor.governance.skipReasons.lowQuality}</Box></span>
                <span>待评分 <Box component="strong" sx={{"fontFamily":"monospace","color":"text.primary"}}>{monitor.governance.skipReasons.pendingScore}</Box></span>
                <span>其他 <Box component="strong" sx={{"fontFamily":"monospace","color":"text.primary"}}>{monitor.governance.skipReasons.other}</Box></span>
              </Box>
            </RadarMonitorSection>
            <RadarMonitorSection title="失败原因">
              {monitor.runs.failures.length === 0 ? (
                <Box component="p" sx={{"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>今天暂无失败来源。</Box>
              ) : (
                <Box component="div" sx={{"display":"flex","flexWrap":"wrap","gap":1}}>
                  {monitor.runs.failures.slice(0, 6).map((failure) => (
                    <Badge key={failure.code} variant="outline" sx={{"color":"error.main"}}>
                      {failure.code} · {failure.count}
                    </Badge>
                  ))}
                </Box>
              )}
            </RadarMonitorSection>
          </Box>
        </div>
      </Box>
    </Box>
  );
}

function RadarMonitorSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Box component="div" sx={{"minWidth":0,"px":2,"py":1.5}}>
      <Box component="div" sx={{"mb":1.5,"display":"flex","alignItems":"baseline","justifyContent":"space-between","gap":1}}>
        <Box component="h3" sx={{"fontSize":"var(--dr-type-body)","fontWeight":"var(--dr-weight-semibold)"}}>{title}</Box>
        {hint ? <Box component="span" sx={{"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>{hint}</Box> : null}
      </Box>
      {children}
    </Box>
  );
}

function RadarScoringRules() {
  return (
    <Box data-admin-hover-group="true" component="details" sx={{"mb":2,"overflow":"hidden","borderRadius":"var(--dr-radius-small)","border":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"background.paper"}}>
      <Box component="summary" sx={{"display":"flex","cursor":"pointer","listStyle":"none","alignItems":"center","justifyContent":"space-between","gap":1.5,"px":2,"py":1.5,"&::-webkit-details-marker":{"display":"none"}}}>
        <div>
          <Box component="h2" sx={{"fontSize":"var(--dr-type-title-small)","fontWeight":"var(--dr-weight-semibold)"}}>评分与阅读等级规则</Box>
          <Box component="p" sx={{"mt":0.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>7 个评分维度 · 3 个来源 profile</Box>
        </div>
        <Box component={ChevronDown} sx={{"width":16,"height":16,"flexShrink":0,"color":"text.secondary","transition":"transform var(--dr-motion-fast)","details[open] &":{"transform":"rotate(180deg)"}}} aria-hidden />
      </Box>
      <Box component="div" sx={{"borderTop":"1px solid var(--dr-color-outline)","borderColor":"divider","px":2,"py":1.5}}>
        <Box component="p" sx={{"fontSize":"var(--dr-type-caption)","lineHeight":"20px","color":"text.secondary"}}>
          总分为 7 个维度的加权分数（0–100）。等级按经相关性、适用范围和证据校准后的等级分判断。原收藏级已并入精读；所有内容统一在原站阅读。
        </Box>
      </Box>
      <Box component="div" sx={{"overflowX":"auto"}}>
        <Box component="table" sx={{"width":"100%","minWidth":560,"textAlign":"left","fontSize":"var(--dr-type-caption)"}}>
          <Box component="thead" sx={{"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"color-mix(in srgb, var(--dr-color-surface-container) 20%, var(--dr-color-surface))","color":"text.secondary"}}>
            <tr>
              <Box component="th" sx={{"px":2,"py":1,"fontWeight":"var(--dr-weight-medium)"}}>评分 profile</Box>
              <Box component="th" sx={{"px":1.5,"py":1,"fontWeight":"var(--dr-weight-medium)"}}>精读</Box>
              <Box component="th" sx={{"px":1.5,"py":1,"fontWeight":"var(--dr-weight-medium)"}}>速读</Box>
              <Box component="th" sx={{"px":1.5,"py":1,"fontWeight":"var(--dr-weight-medium)"}}>不推荐</Box>
            </tr>
          </Box>
          <Box component="tbody" sx={{"& > :not(:last-child)":{"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"var(--dr-color-outline)"}}}>
            <tr>
              <Box component="td" sx={{"px":2,"py":1.5,"fontWeight":"var(--dr-weight-medium)"}}>工程内容 / GitHub</Box>
              <Box component="td" sx={{"px":1.5,"py":1.5,"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>≥ 55</Box>
              <Box component="td" sx={{"px":1.5,"py":1.5,"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>38–54.99</Box>
              <Box component="td" sx={{"px":1.5,"py":1.5,"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>&lt; 38</Box>
            </tr>
            <tr>
              <Box component="td" sx={{"px":2,"py":1.5,"fontWeight":"var(--dr-weight-medium)"}}>研究论文 / arXiv</Box>
              <Box component="td" sx={{"px":1.5,"py":1.5,"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>≥ 60</Box>
              <Box component="td" sx={{"px":1.5,"py":1.5,"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>42–59.99</Box>
              <Box component="td" sx={{"px":1.5,"py":1.5,"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>&lt; 42</Box>
            </tr>
            <tr>
              <Box component="td" sx={{"px":2,"py":1.5,"fontWeight":"var(--dr-weight-medium)"}}>行业新闻 / 产品动态</Box>
              <Box component="td" sx={{"px":1.5,"py":1.5,"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>≥ 52</Box>
              <Box component="td" sx={{"px":1.5,"py":1.5,"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>38–51.99</Box>
              <Box component="td" sx={{"px":1.5,"py":1.5,"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>&lt; 38</Box>
            </tr>
          </Box>
        </Box>
      </Box>
      <Box component="div" sx={{"borderTop":"1px solid var(--dr-color-outline)","borderColor":"divider","px":2,"py":1.5,"fontSize":"var(--dr-type-caption)","lineHeight":"20px","color":"text.secondary"}}>
        评分维度：信息增量、分析深度、可行动性、事实可信度、时效性、表达质量、综合信号。实际分级还会应用相关性、论文可迁移性、风险和疑似搬运等规则。
      </Box>
    </Box>
  );
}

function RunFailureDetails({ runId, sourceName }: { runId: string; sourceName: string }) {
  const q = useQuery<RadarDiagnosticListResponse>({
    queryKey: ['admin-radar-failures', runId],
    queryFn: async () => {
      const r = await fetch(
        `/api/admin/radar/diagnostics?kind=failed&status=all&runId=${encodeURIComponent(runId)}`,
        { cache: 'no-store' },
      );
      if (!r.ok) throw new Error('加载失败条目失败');
      return r.json();
    },
  });
  return (
    <Box component="div" sx={{"borderTop":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"color-mix(in srgb, var(--dr-color-danger) 3%, var(--dr-color-surface))","px":2,"py":1.5}}>
      <Box component="div" sx={{"mb":1,"display":"flex","alignItems":"center","gap":1,"fontSize":"var(--dr-type-caption)","fontWeight":"var(--dr-weight-semibold)","color":"error.main"}}>
        <Box component={FileWarning} sx={{"width":14,"height":14}} />
        {sourceName} · 失败条目
      </Box>
      {q.isLoading ? <Skeleton sx={{"height":40,"width":"100%"}} /> : null}
      {q.isError ? <Box component="p" sx={{"fontSize":"var(--dr-type-caption)","color":"error.main"}}>{(q.error as Error).message}</Box> : null}
      <Box component="div" sx={{"display":"grid","gap":1}}>
        {(q.data?.items ?? []).map((item) => (
          <Box component="div" key={item.id} sx={{"display":"flex","alignItems":"flex-start","justifyContent":"space-between","gap":1.5,"borderRadius":"var(--dr-radius-xs)","border":"1px solid var(--dr-color-outline)","borderColor":"color-mix(in srgb, var(--dr-color-danger) 20%, var(--dr-color-outline))","backgroundColor":"background.paper","p":1.5,"fontSize":"var(--dr-type-caption)"}}>
            <Box component="div" sx={{"minWidth":0}}>
              <Box component="div" sx={{"fontWeight":"var(--dr-weight-medium)"}}>{item.title}</Box>
              <Box component="div" sx={{"mt":0.5,"color":"text.secondary"}}>
                {item.reasonCode} · {item.errorType ?? 'unknown'} · {item.errorDomain ?? 'unknown'}
              </Box>
              {item.reasonMessage ? <Box component="div" sx={{"mt":0.5,"overflowWrap":"anywhere","color":"error.main"}}>{item.reasonMessage}</Box> : null}
            </Box>
            <Box component="a" href={item.url} target="_blank" rel="noreferrer" title="打开原文" aria-label="打开原文" sx={{"flexShrink":0,"color":"text.secondary","&:hover":{"color":"text.primary"}}}>
              <Box component={ExternalLink} sx={{"width":14,"height":14}} />
            </Box>
          </Box>
        ))}
      </Box>
      {!q.isLoading && !q.isError && (q.data?.items.length ?? 0) === 0 ? (
        <Box component="p" sx={{"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>暂无逐条失败记录。历史运行未持久化失败候选。</Box>
      ) : null}
    </Box>
  );
}

function RadarGovernanceTab() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'filtered' | 'failed'>('filtered');
  const [status, setStatus] = useState<'pending' | 'promoted' | 'dismissed' | 'all'>('pending');
  const [query, setQuery] = useState('');
  const [sourceType, setSourceType] = useState('all');
  const [reasonCode, setReasonCode] = useState('all');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<'20' | '50' | '100' | 'all'>('50');
  const [date, setDate] = useState(() => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}-${parts.find((part) => part.type === 'day')?.value}`;
  });
  const [actionMessage, setActionMessage] = useState('');
  const [actionTone, setActionTone] = useState<'success' | 'warning' | 'error'>('success');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmingBulkDismiss, setConfirmingBulkDismiss] = useState(false);
  const q = useQuery<RadarDiagnosticListResponse>({
    queryKey: ['admin-radar-diagnostics', kind, status, date, query, sourceType, reasonCode, sort, page, perPage],
    queryFn: async () => {
      const params = new URLSearchParams({
        kind,
        status,
        date,
        per_page: perPage === 'all' ? 'all' : perPage,
        page: String(page),
        sort,
      });
      if (query.trim()) params.set('q', query.trim());
      if (sourceType !== 'all') params.set('sourceType', sourceType);
      if (reasonCode !== 'all') params.set('reasonCode', reasonCode);
      const r = await fetch(`/api/admin/radar/diagnostics?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('加载雷达诊断失败');
      return r.json();
    },
  });
  const countsQ = useQuery({
    queryKey: ['admin-radar-diagnostic-counts', date],
    queryFn: async () => {
      const combinations = [
        ['filtered', 'pending'],
        ['filtered', 'promoted'],
        ['filtered', 'dismissed'],
        ['failed', 'pending'],
        ['failed', 'all'],
      ] as const;
      const responses = await Promise.all(
        combinations.map(async ([nextKind, nextStatus]) => {
          const r = await fetch(
            `/api/admin/radar/diagnostics?kind=${nextKind}&status=${nextStatus}&date=${date}&per_page=1`,
            { cache: 'no-store' },
          );
          if (!r.ok) throw new Error('加载队列统计失败');
          return r.json() as Promise<{ total: number }>;
        }),
      );
      return {
        filteredPending: responses[0].total,
        filteredPromoted: responses[1].total,
        filteredDismissed: responses[2].total,
        failedPending: responses[3].total,
        failedTotal: responses[4].total,
      };
    },
    refetchInterval: 5_000,
  });
  const actionMut = useMutation({
    mutationFn: async (input: { id: string; action: 'promote' | 'dismiss' }) => {
      const r = await fetch(`/api/admin/radar/diagnostics/${input.id}/${input.action}`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ message: '操作失败' }));
        throw new Error((body as { message?: string }).message ?? '操作失败');
      }
      return r.json();
    },
    onSuccess: () => {
      setActionMessage('操作已完成');
      setActionTone('success');
      queryClient.invalidateQueries({ queryKey: ['admin-radar-diagnostics'] });
      queryClient.invalidateQueries({ queryKey: ['admin-radar-diagnostic-counts'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
    onError: (error) => {
      setActionMessage((error as Error).message);
      setActionTone('error');
    },
  });
  const bulkActionMut = useMutation({
    mutationFn: async (action: 'promote' | 'dismiss') => {
      const results: Array<{ id: string; ok: boolean; message?: string }> = [];
      for (const id of selectedIds) {
        try {
          const response = await fetch(`/api/admin/radar/diagnostics/${id}/${action}`, { method: 'POST' });
          if (response.ok) {
            results.push({ id, ok: true });
          } else {
            const body = await response.json().catch(() => ({ message: '请求失败' }));
            results.push({ id, ok: false, message: (body as { message?: string }).message ?? `HTTP ${response.status}` });
          }
        } catch (error) {
          results.push({ id, ok: false, message: error instanceof Error ? error.message : '网络请求失败' });
        }
      }
      return results;
    },
    onSuccess: (results, action) => {
      const summary = summarizeAdminBulkResults(results, action === 'promote' ? '提升到雷达' : '忽略');
      setSelectedIds(summary.failedIds);
      setActionMessage(summary.message);
      setActionTone(summary.failedIds.length ? 'warning' : 'success');
      queryClient.invalidateQueries({ queryKey: ['admin-radar-diagnostics'] });
      queryClient.invalidateQueries({ queryKey: ['admin-radar-diagnostic-counts'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
    onError: (error) => {
      setActionMessage((error as Error).message);
      setActionTone('error');
    },
  });
  useEffect(() => {
    setSelectedIds([]);
  }, [date, kind, page, perPage, query, reasonCode, sort, sourceType, status]);
  const counts = countsQ.data;
  const visiblePendingItems = (q.data?.items ?? []).filter(
    (item) => kind === 'filtered' && item.status === 'pending',
  );
  const visiblePendingIds = visiblePendingItems.map((item) => item.id);
  const allVisibleSelected = visiblePendingIds.length > 0
    && visiblePendingIds.every((id) => selectedIds.includes(id));

  function toggleSelected(id: string, checked: boolean) {
    setSelectedIds((current) => checked
      ? (current.includes(id) ? current : [...current, id])
      : current.filter((itemId) => itemId !== id));
  }

  function setPriorityQueue(next: 'priority' | 'failed' | 'score') {
    setPage(1);
    if (next === 'failed') {
      setKind('failed');
      setStatus('pending');
      setSort('priority');
      return;
    }
    setKind('filtered');
    setStatus('pending');
    setReasonCode('all');
    setSort(next === 'score' ? 'score' : 'priority');
  }

  return (
    <Box component="div" sx={{"& > :not(style) ~ :not(style)":{"marginTop":2}}}>
      <PageHeader
        title="雷达治理"
        description="查看不推荐、待评分和其他未进入雷达展示的内容，定位来源级失败，并把有价值的内容提升回雷达。"
      />

      <Box component="div" sx={{"display":"grid","gridTemplateColumns":"repeat(2, minmax(0, 1fr))","gap":1,"@media (min-width:1024px)":{"gridTemplateColumns":"repeat(5, minmax(0, 1fr))"}}}>
        <GovernanceMetric
          label="待治理 canonical"
          value={counts?.filteredPending ?? '—'}
          tone="warning"
          icon={<ListFilter />}
        />
        <GovernanceMetric
          label="待处理失败"
          value={counts?.failedPending ?? '—'}
          tone="danger"
          icon={<CircleAlert />}
        />
        <GovernanceMetric
          label="已 promote"
          value={counts?.filteredPromoted ?? '—'}
          tone="success"
          icon={<CheckCircle2 />}
        />
        <GovernanceMetric
          label="已忽略"
          value={counts?.filteredDismissed ?? '—'}
          tone="muted"
          icon={<Eye />}
        />
        <GovernanceMetric
          label="未恢复失败率"
          value={q.data ? `${q.data.failureRate.percent}%` : '—'}
          tone={q.data?.failureRate.withinTarget ? 'success' : 'danger'}
          icon={<Activity />}
        />
      </Box>
      {q.data ? (
        <Box component="p" sx={{"mt":-1,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
          去重口径：{q.data.failureRate.failed} 个未恢复失败 / {q.data.failureRate.attempted} 个唯一尝试，目标 &lt; 1%
        </Box>
      ) : null}

      <Box component="div" sx={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":1,"borderRadius":"var(--dr-radius-small)","border":"1px solid var(--dr-color-outline)","borderColor":"color-mix(in srgb, var(--dr-color-primary) 20%, var(--dr-color-outline))","backgroundColor":"color-mix(in srgb, var(--dr-color-primary) 4%, var(--dr-color-surface))","px":1.5,"py":1.5}}>
        <Box component="span" sx={{"mr":0.5,"fontSize":"var(--dr-type-caption)","fontWeight":"var(--dr-weight-semibold)"}}>优先队列</Box>
        <Button
          type="button"
          size="xs"
          variant={kind === 'filtered' && sort === 'priority' ? 'default' : 'outline'}
          onClick={() => setPriorityQueue('priority')}
        >
          <Timer />
          优先处理
        </Button>
        <Button
          type="button"
          size="xs"
          variant={kind === 'failed' ? 'destructive' : 'outline'}
          onClick={() => setPriorityQueue('failed')}
        >
          <CircleAlert />
          失败 / 不可用
        </Button>
        <Button
          type="button"
          size="xs"
          variant={kind === 'filtered' && sort === 'score' ? 'default' : 'outline'}
          onClick={() => setPriorityQueue('score')}
        >
          <Activity />
          低置信度
        </Button>
        <Box component="span" sx={{"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
          先处理失败、待评分和不可评估内容，再看普通噪声。
        </Box>
      </Box>

      <Box component="section" sx={{"overflow":"hidden","borderRadius":"var(--dr-radius-small)","border":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"background.paper"}}>
        <Box component="div" sx={{"display":"flex","flexWrap":"wrap","alignItems":"center","justifyContent":"space-between","gap":1.5,"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","px":2,"py":1.5}}>
          <Box component="div" sx={{"display":"inline-flex","borderRadius":"var(--dr-radius-small)","border":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"color-mix(in srgb, var(--dr-color-surface-container) 30%, var(--dr-color-surface))","p":0.5}}>
            {([
              ['filtered', '待治理内容', counts?.filteredPending ?? 0],
              ['failed', '失败条目', counts?.failedPending ?? 0],
            ] as const).map(([nextKind, label, count]) => (
              <Button
                key={nextKind}
                type="button"
                aria-pressed={kind === nextKind}
                variant={kind === nextKind ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => {
                  setKind(nextKind);
                  setStatus('pending');
                  setPage(1);
                  setActionMessage('');
                  setActionTone('success');
                }}
              >
                {label}
                <Box component="span" sx={[{"borderRadius":"var(--dr-radius-pill)","px":1,"py":0.5,"fontFamily":"monospace","fontSize":"var(--dr-type-caption)"}, kind === nextKind ? {"backgroundColor":"var(--dr-color-primary-container)","color":"primary.main"} : {"backgroundColor":"action.hover","color":"text.secondary"}]}>
                  {count}
                </Box>
              </Button>
            ))}
          </Box>
          <Box component="div" sx={{"display":"flex","alignItems":"center","gap":1}}>
            <Box component="label" sx={{"position":"absolute","width":1,"height":1,"padding":0,"margin":-1,"overflow":"hidden","clip":"rect(0, 0, 0, 0)","whiteSpace":"nowrap","border":0}} htmlFor="radar-governance-date">诊断日期</Box>
            <Input
              id="radar-governance-date"
              type="date"
              value={date === 'all' ? '' : date}
              onChange={(event) => { setDate(event.target.value || 'all'); setPage(1); }}
              sx={{"height":32,"width":144,"fontSize":"var(--dr-type-caption)"}}
            />
            <Button
              type="button"
              variant={date === 'all' ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => { setDate('all'); setPage(1); }}
            >
              全部日期
            </Button>
            <Box component="label" sx={{"position":"absolute","width":1,"height":1,"padding":0,"margin":-1,"overflow":"hidden","clip":"rect(0, 0, 0, 0)","whiteSpace":"nowrap","border":0}} htmlFor="radar-governance-status">记录状态</Box>
            <Select value={status} onValueChange={(value) => { setStatus(value as typeof status); setPage(1); }}>
              <SelectTrigger id="radar-governance-status" sx={{"height":32,"width":128,"fontSize":"var(--dr-type-caption)"}}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">{kind === 'filtered' ? '待处理' : '未解决'}</SelectItem>
                {kind === 'filtered' ? <SelectItem value="promoted">已 promote</SelectItem> : null}
                {kind === 'filtered' ? <SelectItem value="dismissed">已忽略</SelectItem> : null}
                <SelectItem value="all">全部状态</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sourceType} onValueChange={(value) => { setSourceType(value); setPage(1); }}>
              <SelectTrigger sx={{"height":32,"width":144,"fontSize":"var(--dr-type-caption)"}} aria-label="来源筛选">
                <SelectValue placeholder="全部来源" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部来源</SelectItem>
                <SelectItem value="github_topic_search">GitHub 话题搜索</SelectItem>
                <SelectItem value="github_trending">GitHub 趋势</SelectItem>
                <SelectItem value="arxiv">arXiv</SelectItem>
                <SelectItem value="rss">RSS / 博客</SelectItem>
                <SelectItem value="devto">Dev.to</SelectItem>
                <SelectItem value="hackernews">Hacker News</SelectItem>
                <SelectItem value="huggingface_models">Hugging Face</SelectItem>
              </SelectContent>
            </Select>
            <Select value={reasonCode} onValueChange={(value) => { setReasonCode(value); setPage(1); }}>
              <SelectTrigger sx={{"height":32,"width":144,"fontSize":"var(--dr-type-caption)"}} aria-label="原因筛选">
                <SelectValue placeholder="全部原因" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部原因</SelectItem>
                <SelectItem value="DISTILLED_NOISE">评分噪声</SelectItem>
                <SelectItem value="DISTILLED_UNASSESSABLE">不可评估</SelectItem>
                <SelectItem value="DISTILLED_HARD_VETO">硬否决</SelectItem>
                <SelectItem value="RULE_NOISE">规则噪声</SelectItem>
                <SelectItem value="LOW_QUALITY">内容不足</SelectItem>
                <SelectItem value="CONTENT_FETCH_FAILED">抓取失败</SelectItem>
                <SelectItem value="PENDING_SCORE">待评分</SelectItem>
                <SelectItem value="AI_ENGINE_UNAVAILABLE">AI 不可用</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(value) => { setSort(value); setPage(1); }}>
              <SelectTrigger sx={{"height":32,"width":128,"fontSize":"var(--dr-type-caption)"}} aria-label="排序方式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">最新优先</SelectItem>
                <SelectItem value="oldest">最早优先</SelectItem>
                <SelectItem value="source">按来源</SelectItem>
                <SelectItem value="reason">按原因</SelectItem>
                <SelectItem value="score">按评分</SelectItem>
                <SelectItem value="priority">优先处理</SelectItem>
              </SelectContent>
            </Select>
            <Select value={perPage} onValueChange={(value) => { setPerPage(value as typeof perPage); setPage(1); }}>
              <SelectTrigger sx={{"height":32,"width":96,"fontSize":"var(--dr-type-caption)"}} aria-label="每页条数">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="20">20 条</SelectItem>
                <SelectItem value="50">50 条</SelectItem>
                <SelectItem value="100">100 条</SelectItem>
                <SelectItem value="all">全部</SelectItem>
              </SelectContent>
            </Select>
            <Box component="span" sx={{"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
              {q.isLoading ? '加载中…' : `${q.data?.items.length ?? 0} / ${q.data?.total ?? 0} 条`}
            </Box>
          </Box>
        </Box>
        <Box component="div" sx={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":1,"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"color-mix(in srgb, var(--dr-color-surface-container) 10%, var(--dr-color-surface))","px":2,"py":1}}>
          <Box component={SearchIcon} sx={{"width":16,"height":16,"color":"text.secondary"}} aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(1); }}
            placeholder="搜索标题、URL 或失败信息"
            aria-label="搜索治理条目"
            sx={{"height":32,"minWidth":224,"maxWidth":448,"fontSize":"var(--dr-type-caption)"}}
          />
          <Box component="span" sx={{"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>筛选结果按 canonicalUrl 去重</Box>
        </Box>
        {actionMessage ? (
          <Alert severity={actionTone} role={actionTone === 'error' ? 'alert' : 'status'} sx={{ borderRadius: 0 }}>
            {actionMessage}
          </Alert>
        ) : null}
        {kind === 'filtered' && status === 'pending' && visiblePendingIds.length > 0 ? (
          <Box component="div" sx={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":1,"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"color-mix(in srgb, var(--dr-color-surface-container) 10%, var(--dr-color-surface))","px":2,"py":1,"fontSize":"var(--dr-type-caption)"}}>
            <Box component="label" sx={{"display":"inline-flex","cursor":"pointer","alignItems":"center","gap":1,"fontWeight":"var(--dr-weight-medium)"}}>
              <Checkbox
                size="small"
                checked={allVisibleSelected}
                onChange={(event) => setSelectedIds(event.target.checked ? visiblePendingIds : [])}
                aria-label="全选当前页待治理内容"
              />
              全选当前页
            </Box>
            {selectedIds.length > 0 ? (
              <>
                <Box component="span" sx={{"color":"text.secondary"}}>已选 {selectedIds.length} 条</Box>
                <Button
                  type="button"
                  size="xs"
                  disabled={bulkActionMut.isPending}
                  onClick={() => bulkActionMut.mutate('promote')}
                >
                  <Check />
                  批量提升
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={bulkActionMut.isPending}
                  onClick={() => setConfirmingBulkDismiss(true)}
                >
                  <EyeOff />
                  批量忽略
                </Button>
              </>
            ) : (
              <Box component="span" sx={{"color":"text.secondary"}}>批量提升或忽略当前页内容</Box>
            )}
          </Box>
        ) : null}
      {q.isLoading ? <QueueSkeleton /> : null}
      {q.isError ? <Box component="p" sx={{"fontSize":"var(--dr-type-body)","color":"error.main"}}>{(q.error as Error).message}</Box> : null}
      <Box component="div" sx={{"& > :not(:last-child)":{"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"var(--dr-color-outline)"}}}>
        {(q.data?.items ?? []).map((item) => (
          <Box data-admin-hover-group="true" component="div" key={item.id} sx={{"px":2,"py":2,"transition":"color, background-color, border-color var(--dr-motion-fast)","&:hover":{"backgroundColor":"color-mix(in srgb, var(--dr-color-surface-container) 20%, var(--dr-color-surface))"}}}>
            <Box component="div" sx={{"display":"flex","alignItems":"flex-start","gap":1.5}}>
              {kind === 'filtered' && item.status === 'pending' ? (
                <Checkbox
                  size="small"
                  checked={selectedIds.includes(item.id)}
                  onChange={(event) => toggleSelected(item.id, event.target.checked)}
                  aria-label={`选择治理条目：${item.title}`}
                  sx={{ mt: -0.5 }}
                />
              ) : null}
              <Box component="span"
                sx={[{"mt":1,"width":8,"height":8,"flexShrink":0,"borderRadius":"var(--dr-radius-pill)"}, item.kind === 'failed' ? {"backgroundColor":"error.main"} : {"backgroundColor":"var(--dr-color-tier-noise)"}]}
                aria-hidden="true"
              />
              <Box component="div" sx={{"minWidth":0,"flex":"1 1 0%"}}>
              <Box component="div" sx={{"display":"flex","alignItems":"flex-start","justifyContent":"space-between","gap":1.5}}>
                <Box component="div" sx={{"minWidth":0}}>
                  <Box component="div" sx={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":1}}>
                    <Box component="h3" sx={{"fontWeight":"var(--dr-weight-medium)","lineHeight":"var(--dr-line-height-heading)"}}>{item.title}</Box>
                    <Badge variant="outline">{item.source.name}</Badge>
                    {item.distilledTier ? <Badge variant="secondary">{readingTierLabel(item.distilledTier)}</Badge> : null}
                    {item.resolved ? <Badge variant="secondary">已恢复</Badge> : null}
                  </Box>
                  <Box component="div" sx={{"mt":1,"display":"flex","flexWrap":"wrap","alignItems":"center","columnGap":1,"rowGap":0.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
                    <Box component="code" sx={item.kind === 'failed' ? {"color":"error.main"} : undefined}>{item.reasonCode}</Box>
                    <span aria-hidden="true">·</span>
                    <span>{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
                  </Box>
                </Box>
                <Box component="div" sx={{"display":"flex","flexShrink":0,"alignItems":"center","gap":0.5}}>
                  <Box component="a" href={item.url} target="_blank" rel="noreferrer" title="打开原文" aria-label="打开原文" sx={{"borderRadius":"var(--dr-radius-xs)","p":1,"color":"text.secondary","opacity":0.7,"&:hover":{"backgroundColor":"action.hover","color":"text.primary"},"[data-admin-hover-group]:hover &":{"opacity":1}}}>
                    <Box component={ExternalLink} sx={{"width":16,"height":16}} />
                  </Box>
                  {kind === 'filtered' && item.status === 'pending' ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={actionMut.isPending}
                          aria-label={`打开治理操作：${item.title}`}
                          title="更多治理操作"
                          sx={{"color":"text.secondary","&:hover":{"color":"text.primary"}}}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={actionMut.isPending}
                          onSelect={() => actionMut.mutate({ id: item.id, action: 'promote' })}
                        >
                          <Check />
                          提升到雷达
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={actionMut.isPending}
                          sx={{"color":"text.secondary"}}
                          onSelect={() => actionMut.mutate({ id: item.id, action: 'dismiss' })}
                        >
                          <EyeOff />
                          忽略
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </Box>
              </Box>
              {item.reasonMessage ? (
                <Box component="p" sx={[{"mt":1,"fontSize":"var(--dr-type-caption)"}, item.kind === 'failed' ? {"color":"error.main"} : {"color":"text.secondary"}]}>
                  {item.reasonMessage}
                </Box>
              ) : null}
              {item.body ? (
                <Box component="p" sx={{"mt":1,"display":"-webkit-box","WebkitBoxOrient":"vertical","WebkitLineClamp":2,"overflow":"hidden","fontSize":"var(--dr-type-body)","lineHeight":"var(--dr-line-height-body)","color":"text.secondary"}}>
                  {governancePreview(item.body)}
                </Box>
              ) : null}
              {item.kind === 'failed' && item.errorType ? (
                <Box component="p" sx={{"mt":1,"display":"inline-flex","alignItems":"center","gap":0.5,"fontSize":"var(--dr-type-caption)","color":"error.main"}}>
                  <Box component={FileWarning} sx={{"width":14,"height":14}} />
                  {item.errorType} · {item.errorDomain ?? 'unknown'}
                </Box>
              ) : null}
              </Box>
            </Box>
          </Box>
        ))}
      </Box>
      {!q.isLoading && !q.isError && (q.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title={kind === 'filtered' ? '暂无待治理内容' : '暂无失败条目'}
          description={kind === 'filtered'
            ? '不推荐、待评分、规则噪声和低质量内容会出现在这里。当前没有待处理记录。'
            : '新的同步失败会在这里留下逐条记录。当前没有未解决失败。'}
          action={kind === 'filtered' && (counts?.failedPending ?? 0) > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={() => {
              setKind('failed');
              setStatus('pending');
            }}>
              <FileWarning />
              查看失败条目（{counts?.failedPending}）
            </Button>
          ) : undefined}
        />
      ) : null}
      {q.data && q.data.totalPages > 1 ? (
        <Pagination page={q.data.page} totalPages={q.data.totalPages} onPageChange={setPage} disabled={q.isFetching} />
      ) : null}
      </Box>
      <AppDialog
        open={confirmingBulkDismiss}
        onClose={() => setConfirmingBulkDismiss(false)}
        title="忽略选中内容？"
        description={`确定忽略选中的 ${selectedIds.length} 条内容吗？`}
        actions={(
          <>
            <AppButton type="button" variant="outlined" onClick={() => setConfirmingBulkDismiss(false)}>
              取消
            </AppButton>
            <AppButton
              type="button"
              variant="contained"
              color="error"
              onClick={() => {
                setConfirmingBulkDismiss(false);
                bulkActionMut.mutate('dismiss');
              }}
            >
              确认忽略
            </AppButton>
          </>
        )}
      />
    </Box>
  );
}

function governancePreview(value: string): string {
  return cleanResearchText(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/`{1,3}/gu, '')
    .replace(/[#>*_~|]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function GovernanceMetric({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number | string;
  tone: 'warning' | 'danger' | 'success' | 'muted';
  icon: React.ReactNode;
}) {
  const toneSx = {
    warning: { color: 'warning.main', backgroundColor: 'var(--dr-color-warning-container)' },
    danger: { color: 'error.main', backgroundColor: 'var(--dr-color-danger-container)' },
    success: { color: 'success.main', backgroundColor: 'var(--dr-color-success-container)' },
    muted: { color: 'text.secondary', backgroundColor: 'action.hover' },
  }[tone];
  return (
    <Box component="div" sx={{"borderRadius":"var(--dr-radius-small)","border":"1px solid var(--dr-color-outline)","borderColor":"divider","backgroundColor":"background.paper","p":1.5}}>
      <Box component="div" sx={{"display":"flex","alignItems":"center","justifyContent":"space-between","gap":1,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
        <span>{label}</span>
        <Box component="span" sx={[{ display: 'inline-flex', width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--dr-radius-xs)' }, toneSx]}>{icon}</Box>
      </Box>
      <Typography
        component="div"
        variant="h2"
        sx={{ mt: 1, fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </Typography>
    </Box>
  );
}

function readingTierLabel(tier: string): string {
  return {
    collection: '核心材料',
    deep_read: '推荐精读',
    skim: '速览',
    noise: '不推荐',
    pending: '待评分',
  }[tier] ?? tier;
}

function formatElapsed(elapsedMs: number | null): string {
  if (elapsedMs == null) return '进行中';
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

function formatRunTime(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function stageCount(completed: number, total: number): string {
  return total === 0 ? '—' : `${completed}/${total}`;
}

function RadarHealthBadge({
  running,
  failed,
  partial,
  pending,
}: {
  running: number;
  failed: number;
  partial: number;
  pending: number;
}) {
  if (running > 0) {
    return (
      <Box component="span" sx={{"display":"inline-flex","alignItems":"center","gap":0.5,"borderRadius":"var(--dr-radius-pill)","backgroundColor":"var(--dr-color-primary-container)","px":1,"py":0.5,"fontSize":"var(--dr-type-caption)","fontWeight":"var(--dr-weight-medium)","color":"primary.main"}}>
        <Box component={Activity} sx={{"width":12,"height":12}} />
        同步中
      </Box>
    );
  }
  if (failed > 0 || partial > 0) {
    return (
      <Box component="span" sx={{"display":"inline-flex","alignItems":"center","gap":0.5,"borderRadius":"var(--dr-radius-pill)","backgroundColor":"var(--dr-color-danger-container)","px":1,"py":0.5,"fontSize":"var(--dr-type-caption)","fontWeight":"var(--dr-weight-medium)","color":"error.main"}}>
        <Box component={AlertTriangle} sx={{"width":12,"height":12}} />
        有异常
      </Box>
    );
  }
  if (pending > 0) {
    return (
      <Box component="span" sx={{"display":"inline-flex","alignItems":"center","gap":0.5,"borderRadius":"var(--dr-radius-pill)","backgroundColor":"var(--dr-color-warning-container)","px":1,"py":0.5,"fontSize":"var(--dr-type-caption)","fontWeight":"var(--dr-weight-medium)","color":"warning.main"}}>
        <Box component={Activity} sx={{"width":12,"height":12}} />
        后处理中
      </Box>
    );
  }
  return (
    <Box component="span" sx={{"display":"inline-flex","alignItems":"center","gap":0.5,"borderRadius":"var(--dr-radius-pill)","backgroundColor":"var(--dr-color-success-container)","px":1,"py":0.5,"fontSize":"var(--dr-type-caption)","fontWeight":"var(--dr-weight-medium)","color":"success.main"}}>
      <Box component={CheckCircle2} sx={{"width":12,"height":12}} />
      已完成
    </Box>
  );
}

function RadarMetric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  return (
    <Box component="div" sx={{"px":2,"py":1.5}}>
      <Box component="div" sx={{"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>{label}</Box>
      <Box component="div"
        sx={[{"mt":0.5,"fontFamily":"monospace","fontSize":"var(--dr-type-title-compact)","fontWeight":"var(--dr-weight-semibold)","fontVariantNumeric":"tabular-nums"}, tone === 'default' && {"color":"text.primary"}, tone === 'success' && {"color":"success.main"}, tone === 'warning' && {"color":"warning.main"}, tone === 'danger' && {"color":"error.main"}]}
      >
        {value}
      </Box>
    </Box>
  );
}

function PipelineMetric({
  label,
  completed,
  total,
  pending,
}: {
  label: string;
  completed: number;
  total: number;
  pending: number;
}) {
  const complete = total > 0 && pending === 0;
  return (
    <Box component="div" sx={{"display":"flex","alignItems":"center","justifyContent":"flex-start","gap":1,"py":0.5}}>
      <Box component="span" sx={{"color":"text.secondary"}}>{label}</Box>
      <Box component="span"
        sx={[{"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}, complete && {"color":"success.main"}, pending > 0 && {"color":"warning.main"}]}
      >
        {stageCount(completed, total)}
      </Box>
    </Box>
  );
}

export function shanghaiDateValue(value: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => (
    parts.find((item) => item.type === type)?.value ?? ''
  );
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function SyncStatusBadge({ status }: { status: string }) {
  const s = syncStatusStyle(status);
  return (
    <Box component="span" sx={[{ borderRadius: 'var(--dr-radius-pill)', px: 1, py: 0.5, fontSize: 'var(--dr-type-caption)', fontWeight: 'var(--dr-weight-medium)' }, s.sx]}>
      {s.label}
    </Box>
  );
}

/**
 * Pure helper：雷达同步状态 → 中文 label + 共享 token 配色。
 * 导出供单测使用（项目未装 @testing-library/react，只测纯函数）。
 */
export function syncStatusStyle(status: string) {
  const map = {
    running: { label: '运行中', sx: { backgroundColor: 'var(--dr-color-primary-container)', color: 'primary.main' } },
    completed: { label: '完成', sx: { backgroundColor: 'var(--dr-color-success-container)', color: 'success.main' } },
    partial: { label: '部分', sx: { backgroundColor: 'var(--dr-color-warning-container)', color: 'warning.main' } },
    failed: { label: '失败', sx: { backgroundColor: 'var(--dr-color-danger-container)', color: 'error.main' } },
  };
  return map[status as keyof typeof map] ?? { label: status, sx: { backgroundColor: 'action.hover', color: 'text.secondary' } };
}

// ──────────────────────────────────────────────────────────────────────
// 用户分享审核
// ──────────────────────────────────────────────────────────────────────

const SHARE_STATUS_OPTIONS = [
  { key: 'pending', label: '待审核' },
  { key: 'approved', label: '已批准' },
  { key: 'rejected', label: '已拒绝' },
] as const;

function SharesTab() {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [page, setPage] = useState(1);
  const [rejectingShare, setRejectingShare] = useState<{ id: string; title: string } | null>(null);
  const queryClient = useQueryClient();

  const q = useQuery<ShareListResponse>({
    queryKey: ['admin-shares', status, page],
    queryFn: async () => {
      const params = new URLSearchParams({ status, page: String(page), per_page: '20' });
      const r = await fetch(`/api/admin/shares?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
  });

  const reviewMut = useMutation({
    mutationFn: async (input: { id: string; action: 'approve' | 'reject'; reason?: string }) => {
      const r = await fetch(`/api/admin/shares/${input.id}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: input.action, reason: input.reason ?? '审核拒绝' }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '操作失败' }));
        throw new Error((err as { message?: string }).message ?? '操作失败');
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-shares'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
  });

  return (
    <div>
      <FilterPills
        options={SHARE_STATUS_OPTIONS}
        value={status}
        onChange={(s) => {
          setStatus(s);
          setPage(1);
        }}
        trailing={`共 ${q.data?.total ?? '?'} 条`}
      />

      {q.isLoading && <QueueSkeleton />}
      {q.isError && <Box component="p" sx={{"fontSize":"var(--dr-type-body)","color":"error.main"}}>{(q.error as Error).message}</Box>}

      <Box component="ul" sx={{"display":"grid","listStyle":"none","gap":1.5,"p":0}}>
        {(q.data?.items ?? []).map((it) => (
          <li key={it.id}>
            <Card sx={{"transition":"color, background-color, border-color var(--dr-motion-fast)","transitionDuration":"200ms","&:hover":{"borderColor":"color-mix(in srgb, var(--dr-color-primary) 40%, var(--dr-color-outline))"}}}>
              <CardContent sx={{"p":2}}>
            <Box component="div" sx={{"display":"flex","alignItems":"flex-start","justifyContent":"space-between","gap":1.5}}>
              <Box component="div" sx={{"minWidth":0,"flex":"1 1 0%"}}>
                <Box component="h3" sx={{"fontSize":"var(--dr-type-title-small)","fontWeight":"var(--dr-weight-semibold)"}}>
                  <Box component="a"
                    href={it.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{"&:hover":{"color":"primary.main","textDecoration":"underline"}}}
                  >
                    {it.fetchedTitle ?? it.url}
                  </Box>
                </Box>
                <Box component="p" sx={{"mt":0.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
                  分享人：{it.submitter.name}（{it.submitter.email}） ·{' '}
                  {new Date(it.createdAt).toLocaleString('zh-CN')}
                </Box>
                {it.userNote && (
                  <Box component="p" sx={{"mt":1,"display":"flex","alignItems":"flex-start","gap":1,"borderRadius":"var(--dr-radius-xs)","backgroundColor":"action.hover","px":1,"py":0.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
                    <Box component={MessageSquare} sx={{"mt":0.5,"width":12,"height":12,"flexShrink":0}} />
                    {it.userNote}
                  </Box>
                )}
                {it.summaryText && (
                  <Box component="details" sx={{"mt":1}}>
                    <Box component="summary" sx={{"cursor":"pointer","fontSize":"var(--dr-type-caption)","color":"primary.main"}}>查看 AI 摘要</Box>
                    <Box component="p" sx={{"mt":0.5,"whiteSpace":"pre-wrap","fontSize":"var(--dr-type-caption)","lineHeight":"var(--dr-line-height-body)","color":"text.secondary"}}>
                      {it.summaryText.slice(0, 500)}
                      {it.summaryText.length > 500 && '…'}
                    </Box>
                  </Box>
                )}
                {it.fetchErrorCode && (
                  <Box component="p" sx={{"mt":0.5,"display":"flex","alignItems":"center","gap":0.5,"fontSize":"var(--dr-type-caption)","color":"error.main"}}>
                    <Box component={AlertTriangle} sx={{"width":12,"height":12}} />
                    抓取失败：{it.fetchErrorCode}
                  </Box>
                )}
              </Box>
              {status === 'pending' && (
                <Box component="div" sx={{"display":"flex","flexShrink":0,"flexDirection":"column","gap":1}}>
                  <Button
                    type="button"
                    size="xs"
                    disabled={reviewMut.isPending || !it.summaryText}
                    onClick={() => reviewMut.mutate({ id: it.id, action: 'approve' })}
                  >
                    <Check />
                    批准
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    sx={{"color":"error.main"}}
                    disabled={reviewMut.isPending}
                    onClick={() => setRejectingShare({ id: it.id, title: it.fetchedTitle ?? it.url })}
                  >
                    <X />
                    拒绝
                  </Button>
                </Box>
              )}
            </Box>
              </CardContent>
            </Card>
          </li>
        ))}
      </Box>

      {reviewMut.isError && (
        <Box component="p" sx={{"mt":1,"fontSize":"var(--dr-type-caption)","color":"error.main"}}>
          操作失败：{(reviewMut.error as Error).message}
        </Box>
      )}

      <AdminActionDialog
        open={!!rejectingShare}
        onOpenChange={(o) => !o && setRejectingShare(null)}
        title="拒绝分享"
        description={rejectingShare ? <>分享：<Box component="strong" sx={{"fontWeight":"var(--dr-weight-medium)","color":"text.primary"}}>{rejectingShare.title}</Box></> : undefined}
        fields={[
          { kind: 'textarea', id: 'reason', label: '拒绝原因', required: true, rows: 3, placeholder: '例如：与平台主题无关 / 内容质量不足' },
        ]}
        confirmLabel="确认拒绝"
        destructive
        pending={reviewMut.isPending}
        onSubmit={async (values) => {
          if (!rejectingShare) return;
          await reviewMut.mutateAsync({ id: rejectingShare.id, action: 'reject', reason: String(values.reason) });
          setRejectingShare(null);
        }}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 评论提名
// ──────────────────────────────────────────────────────────────────────

const COMMENT_STATUS_OPTIONS = [
  { key: 'pending', label: '待提炼' },
  { key: 'approved', label: '已提炼' },
  { key: 'rejected', label: '已拒绝' },
  { key: 'all', label: '全部' },
] as const;

function CommentsTab() {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [promotingComment, setPromotingComment] = useState<{ id: string; defaultTitle: string; body: string } | null>(null);
  const [dismissingComment, setDismissingComment] = useState<{ id: string; excerpt: string } | null>(null);
  const queryClient = useQueryClient();

  const q = useQuery<CommentListResponse>({
    queryKey: ['admin-comments', status],
    queryFn: async () => {
      const params = new URLSearchParams({ status, page: '1', per_page: '30' });
      const r = await fetch(`/api/admin/comments?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
  });

  const promoteMut = useMutation({
    mutationFn: async (input: { id: string; title: string; body: string; tags: string[]; conclusion?: string }) => {
      const r = await fetch(`/api/admin/comments/${input.id}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: input.title, body: input.body, tags: input.tags, conclusion: input.conclusion }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '提炼失败' }));
        throw new Error((err as { message?: string }).message ?? '提炼失败');
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-comments'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
  });

  const dismissMut = useMutation({
    mutationFn: async (input: { id: string; reason: string }) => {
      const r = await fetch(`/api/admin/comments/${input.id}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: input.reason }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '拒绝失败' }));
        throw new Error((err as { message?: string }).message ?? '拒绝失败');
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-comments'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
  });

  return (
    <div>
      <FilterPills
        options={COMMENT_STATUS_OPTIONS}
        value={status}
        onChange={setStatus}
        trailing={`共 ${q.data?.total ?? '?'} 条`}
      />

      {q.isLoading && <QueueSkeleton />}
      {q.isError && <Box component="p" sx={{"fontSize":"var(--dr-type-body)","color":"error.main"}}>{(q.error as Error).message}</Box>}

      <Box component="ul" sx={{"display":"grid","listStyle":"none","gap":1.5,"p":0}}>
        {(q.data?.items ?? []).map((it) => (
          <li key={it.id}>
            <Card sx={{"transition":"color, background-color, border-color var(--dr-motion-fast)","transitionDuration":"200ms","&:hover":{"borderColor":"color-mix(in srgb, var(--dr-color-primary) 40%, var(--dr-color-outline))"}}}>
              <CardContent sx={{"p":2}}>
                <Box component="p" sx={{"display":"flex","flexWrap":"wrap","alignItems":"center","columnGap":1,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
              <Box component="strong" sx={{"fontWeight":"var(--dr-weight-medium)","color":"text.primary"}}>{it.author.name}</Box>（
              {it.author.email}） · {new Date(it.createdAt).toLocaleString('zh-CN')} ·
              <Box component="span" sx={{"display":"inline-flex","alignItems":"center","gap":0.5}}>
                <Box component={Sparkles} sx={{"width":12,"height":12}} />
                {it.starCount}
              </Box>
              {it.targetType === 'summary' && it.summary && (
                <>
                  · 来自摘要:
                  <Box component={Link} href={`/radar/${it.summary.id}`} sx={{"color":"primary.main","&:hover":{"textDecoration":"underline"}}}>
                    {it.summary.title}
                  </Box>
                </>
              )}
              {it.targetType === 'research' && it.research && (
                <>
                  · 来自调研库:
                  <Box component={Link}
                    href={`/researches/${it.research.id}`}
                    sx={{"color":"primary.main","&:hover":{"textDecoration":"underline"}}}
                  >
                    {it.research.title}
                  </Box>
                </>
              )}
            </Box>

            <Box component="blockquote" sx={{"my":1,"borderRadius":"0 var(--dr-radius-xs) var(--dr-radius-xs) 0","borderLeft":"2px solid var(--dr-color-outline)","borderLeftColor":"var(--dr-color-primary)","backgroundColor":"var(--dr-color-surface-container)","px":1.5,"py":1,"fontSize":"var(--dr-type-body)","lineHeight":"var(--dr-line-height-body)"}}>
              {it.body}
            </Box>

            {it.promoteStatus === 'nominated' && (
              <Box component="div" sx={{"display":"flex","gap":1}}>
                <Button
                  type="button"
                  size="xs"
                  disabled={promoteMut.isPending || dismissMut.isPending}
                  onClick={() => setPromotingComment({ id: it.id, defaultTitle: it.body.slice(0, 30), body: it.body })}
                >
                  <Sparkles />
                  提炼为知识卡片
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  sx={{"color":"error.main"}}
                  disabled={dismissMut.isPending}
                  onClick={() => setDismissingComment({ id: it.id, excerpt: it.body.slice(0, 80) })}
                >
                  <X />
                  拒绝
                </Button>
              </Box>
            )}
            {it.promoteStatus === 'approved' && (
              <Box component="p" sx={{"display":"flex","alignItems":"center","gap":0.5,"fontSize":"var(--dr-type-caption)","color":"success.main"}}>
                <Box component={CheckCircle2} sx={{"width":14,"height":14}} />
                已提炼为知识卡片
              </Box>
            )}
            {it.promoteStatus === 'rejected' && (
              <Box component="p" sx={{"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>已拒绝</Box>
            )}
              </CardContent>
            </Card>
          </li>
        ))}
      </Box>

      <AdminActionDialog
        open={!!promotingComment}
        onOpenChange={(o) => !o && setPromotingComment(null)}
        title="提炼为知识卡片"
        description="系统会基于评论原文生成知识卡片，标题可自定义。"
        fields={[
          { kind: 'text', id: 'title', label: '知识卡片标题', required: true, maxLength: 80, defaultValue: promotingComment?.defaultTitle },
          { kind: 'markdown', id: 'body', label: '知识卡片正文', required: true, defaultValue: promotingComment?.body, maxLength: 50000, rows: 10 },
          { kind: 'tags', id: 'tags', label: '标签', defaultValue: [], maxTagLength: 40, maxTags: 10 },
          { kind: 'textarea', id: 'conclusion', label: '结论（可选）', rows: 3, maxLength: 2000 },
        ]}
        confirmLabel="提炼"
        pending={promoteMut.isPending}
        onSubmit={async (values) => {
          if (!promotingComment) return;
          await promoteMut.mutateAsync({ id: promotingComment.id, title: String(values.title), body: String(values.body), tags: Array.isArray(values.tags) ? values.tags : [], conclusion: String(values.conclusion || '').trim() || undefined });
          setPromotingComment(null);
        }}
      />

      <AdminActionDialog
        open={!!dismissingComment}
        onOpenChange={(o) => !o && setDismissingComment(null)}
        title="拒绝评论提名"
        description={dismissingComment ? <>评论原文：<Box component="span" sx={{"color":"text.primary"}}>{dismissingComment.excerpt}{dismissingComment.excerpt.length === 80 ? '…' : ''}</Box></> : undefined}
        fields={[
          { kind: 'textarea', id: 'reason', label: '拒绝原因', required: true, rows: 3, placeholder: '例如：与精华主题不符' },
        ]}
        confirmLabel="确认拒绝"
        destructive
        pending={dismissMut.isPending}
        onSubmit={async (values) => {
          if (!dismissingComment) return;
          await dismissMut.mutateAsync({ id: dismissingComment.id, reason: String(values.reason) });
          setDismissingComment(null);
        }}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 研究库管理
// ──────────────────────────────────────────────────────────────────────

const RESEARCH_STATUS_OPTIONS = [
  { key: 'all', label: '全部' },
  { key: 'draft', label: '草稿' },
  { key: 'published', label: '已发布' },
  { key: 'archived', label: '已归档' },
] as const;
type AdminResearchStatus = (typeof RESEARCH_STATUS_OPTIONS)[number]['key'];

const RESEARCH_TYPE_OPTIONS = [
  { key: 'all', label: '全部类型' },
  { key: 'research', label: '研究报告' },
  { key: 'knowledge', label: '知识卡片' },
] as const;
type AdminResearchType = (typeof RESEARCH_TYPE_OPTIONS)[number]['key'];

function ResearchesTab() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AdminResearchStatus>('all');
  const [type, setType] = useState<AdminResearchType>('all');
  const [page, setPage] = useState(1);
  const [searchText, setSearchText] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [confirming, setConfirming] = useState<{
    id: string;
    title: string;
    action: 'archive' | 'restore';
  } | null>(null);

  const q = useQuery<AdminResearchListResponse>({
    queryKey: ['admin-researches', status, type, page, appliedQuery],
    queryFn: async () => {
      const params = new URLSearchParams({
        status,
        page: String(page),
        limit: '20',
      });
      if (type !== 'all') params.set('type', type);
      if (appliedQuery) params.set('q', appliedQuery);
      const r = await fetch(`/api/admin/researches?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
  });

  const actionMut = useMutation({
    mutationFn: async (input: { id: string; action: 'archive' | 'restore' }) => {
      const r = await fetch(`/api/admin/researches/${input.id}/${input.action}`, {
        method: 'POST',
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error((data as { message?: string }).message ?? '操作失败');
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-researches'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
  });

  const featureMut = useMutation({
    mutationFn: async (input: { id: string; action: 'feature' | 'unfeature' }) => {
      const r = await fetch(`/api/admin/researches/${input.id}/${input.action}`, {
        method: 'POST',
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error((data as { message?: string }).message ?? '操作失败');
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-researches'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
  });

  return (
    <div>
      <FilterPills
        options={RESEARCH_STATUS_OPTIONS}
        value={status}
        onChange={(next) => {
          setStatus(next);
          setPage(1);
        }}
        trailing={`共 ${q.data?.total ?? '?'} 条`}
      />

      <Box component="div" sx={{"mb":1.5,"display":"flex","flexWrap":"wrap","alignItems":"center","gap":1}}>
        <Box component="form"
          sx={{"display":"flex","minWidth":220,"flex":"1 1 0%","gap":1,"@media (min-width:640px)":{"maxWidth":448}}}
          onSubmit={(e) => {
            e.preventDefault();
            setAppliedQuery(searchText.trim());
            setPage(1);
          }}
        >
          <Box component="div" sx={{"position":"relative","flex":"1 1 0%"}}>
            <Box component={SearchIcon} sx={{"pointerEvents":"none","position":"absolute","left":12,"top":"50%","width":16,"height":16,"transform":"translateY(-50%)","color":"text.secondary"}} />
            <Input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="搜索标题、正文或标签…"
            aria-label="搜索研究库"
              sx={{"pl":4.5}}
            />
          </Box>
          <Button type="submit" size="sm" variant="outline" sx={{"flexShrink":0}}>
            <SearchIcon />
            搜索
          </Button>
        </Box>

        <Select
          value={type}
          onValueChange={(next) => {
            setType(next as AdminResearchType);
            setPage(1);
          }}
        >
          <SelectTrigger sx={{"width":144}} aria-label="内容类型">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RESEARCH_TYPE_OPTIONS.map((option) => (
              <SelectItem key={option.key} value={option.key}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Box>

      {q.isLoading && <QueueSkeleton />}
      {q.isError && <Box component="p" sx={{"fontSize":"var(--dr-type-body)","color":"error.main"}}>{(q.error as Error).message}</Box>}

      {q.data && q.data.items.length === 0 && (
        <EmptyState
          title="没有匹配的调研"
          description={
            appliedQuery
              ? `没有标题、正文或标签包含「${appliedQuery}」的调研。`
              : '当前筛选条件下没有调研条目。'
          }
        />
      )}

      <Box component="ul" sx={{"display":"grid","listStyle":"none","gap":1.5,"p":0}}>
        {(q.data?.items ?? []).map((item) => (
          <li key={item.id}>
            <Card sx={{"transition":"color, background-color, border-color var(--dr-motion-fast)","transitionDuration":"200ms","&:hover":{"borderColor":"color-mix(in srgb, var(--dr-color-primary) 40%, var(--dr-color-outline))"}}}>
              <CardContent sx={{"p":2}}>
                <Box component="div" sx={{"display":"flex","flexWrap":"wrap","alignItems":"flex-start","justifyContent":"space-between","gap":1.5}}>
                  <Box component="div" sx={{"minWidth":0,"flex":"1 1 0%"}}>
                    <Box component="div" sx={{"mb":1,"display":"flex","flexWrap":"wrap","alignItems":"center","gap":1}}>
                      <StatusBadge kind="method" value={item.creationMethod} />
                      <StatusBadge kind="research" value={item.status} />
                      <Box component="span" sx={{"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
                        {item.type === 'research' ? '研究报告' : '知识卡片'}
                      </Box>
                      {item.featuredAt && (
                        <Box component="span" sx={[{"display":"inline-flex","alignItems":"center","gap":0.5,"borderRadius":"var(--dr-radius-pill)","border":"1px solid var(--dr-color-outline)","px":1,"py":0.5,"fontSize":"var(--dr-type-caption)","fontWeight":"var(--dr-weight-medium)"}, {"borderColor":"warning.main","backgroundColor":"var(--dr-color-warning-container)","color":"warning.main"}]}>
                          <Box component={Star} sx={{"width":12,"height":12}} />
                          精华
                        </Box>
                      )}
                    </Box>

                    <Box component={Link}
                      href={`/researches/${item.id}`}
                      sx={{"borderRadius":"var(--dr-radius-xs)","fontSize":"var(--dr-type-body)","fontWeight":"var(--dr-weight-semibold)","lineHeight":"var(--dr-line-height-heading)","letterSpacing":0,"&:hover":{"color":"primary.main","textDecoration":"underline"}}}
                    >
                      {item.title}
                    </Box>

                    <Box component="p" sx={{"mt":0.5,"display":"-webkit-box","WebkitBoxOrient":"vertical","WebkitLineClamp":2,"overflow":"hidden","fontSize":"var(--dr-type-caption)","lineHeight":"var(--dr-line-height-body)","color":"text.secondary"}}>
                      {adminExcerpt(item.body, 160)}
                    </Box>

                    <Box component="p" sx={{"mt":1,"display":"flex","flexWrap":"wrap","alignItems":"center","columnGap":1,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
                      <span>作者：{item.author.name}</span>
                      <Box component="span" sx={{"fontFamily":"monospace","fontVariantNumeric":"tabular-nums"}}>
                        {new Date(item.publishedAt ?? item.createdAt).toLocaleDateString('zh-CN')}
                      </Box>
                    </Box>
                  </Box>

                  <Box component="div" sx={{"display":"flex","flexShrink":0,"flexDirection":"column","alignItems":"flex-end","gap":1}}>
                    <Box component="div" sx={{"display":"flex","gap":1}}>
                      <Button asChild size="xs" variant="outline" aria-label="查看">
                        <Link href={`/researches/${item.id}`}>
                          <Eye />
                          查看
                        </Link>
                      </Button>
                      {item.status === 'published' && (
                        <Button asChild size="xs" variant="outline" aria-label="编辑">
                          <Link href={`/researches/${item.id}/edit`}>
                            <Pencil />
                            编辑
                          </Link>
                        </Button>
                      )}
                    </Box>
                    {item.status === 'published' && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={actionMut.isPending || featureMut.isPending}
                        onClick={() =>
                          setConfirming({ id: item.id, title: item.title, action: 'archive' })
                        }
                      >
                        <Archive />
                        归档
                      </Button>
                    )}
                    {item.status === 'published' && (
                      <Button
                        type="button"
                        size="xs"
                        variant={item.featuredAt ? 'default' : 'outline'}
                        disabled={actionMut.isPending || featureMut.isPending}
                        onClick={() =>
                          featureMut.mutate({
                            id: item.id,
                            action: item.featuredAt ? 'unfeature' : 'feature',
                          })
                        }
                      >
                        <Box component={Star} sx={item.featuredAt ? {"fill":"currentColor"} : {}} />
                        {item.featuredAt ? '取消精华' : '设为精华'}
                      </Button>
                    )}
                    {item.status === 'archived' && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={actionMut.isPending}
                        onClick={() =>
                          setConfirming({ id: item.id, title: item.title, action: 'restore' })
                        }
                      >
                        <RotateCcw />
                        恢复
                      </Button>
                    )}
                  </Box>
                </Box>
              </CardContent>
            </Card>
          </li>
        ))}
      </Box>

      {(actionMut.isError || featureMut.isError) && (
        <Box component="p" sx={{"mt":1,"fontSize":"var(--dr-type-caption)","color":"error.main"}} role="alert">
          操作失败：{((actionMut.error ?? featureMut.error) as Error).message}
        </Box>
      )}

      <Pagination
        page={page}
        totalPages={q.data?.totalPages ?? 1}
        onPageChange={setPage}
        disabled={q.isFetching}
      />

      <AdminActionDialog
        open={!!confirming}
        onOpenChange={(nextOpen) => !nextOpen && setConfirming(null)}
        title={confirming?.action === 'archive' ? '归档这份调研？' : '恢复这份调研？'}
        description={
          confirming ? (
            <>
              {confirming.action === 'archive'
                ? '归档后仅 admin 可见，普通成员将无法访问。'
                : '恢复后重新对全部成员可见。'}
              <br />
              调研：<Box component="strong" sx={{"fontWeight":"var(--dr-weight-medium)","color":"text.primary"}}>{confirming.title}</Box>
            </>
          ) : undefined
        }
        fields={[]}
        confirmLabel={confirming?.action === 'archive' ? '确认归档' : '确认恢复'}
        destructive={confirming?.action === 'archive'}
        pending={actionMut.isPending}
        onSubmit={async () => {
          if (!confirming) return;
          await actionMut.mutateAsync({
            id: confirming.id,
            action: confirming.action,
          });
          setConfirming(null);
        }}
      />
    </div>
  );
}

function adminExcerpt(body: string, max: number): string {
  const plainText = body.replace(/[#*`>\-\[\]()!_~|]/g, '').replace(/\s+/g, ' ').trim();
  if (plainText.length <= max) return plainText;
  return `${plainText.slice(0, max)}…`;
}

// ──────────────────────────────────────────────────────────────────────
// 成员
// ──────────────────────────────────────────────────────────────────────

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  createdAt: string;
  disabledAt: string | null;
}

interface UserListResponse { items: AdminUser[] }

function UsersTab() {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const q = useQuery<UserListResponse>({
    queryKey: ['admin-users'],
    queryFn: async () => {
      const r = await fetch('/api/admin/users', { cache: 'no-store' });
      if (!r.ok) throw new Error('加载成员失败');
      return r.json();
    },
  });

  const updateMut = useMutation({
    mutationFn: async (input: { id: string; body: { role?: 'admin' | 'member'; disabled?: boolean } }) => {
      const r = await fetch(`/api/admin/users/${input.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input.body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const code = (data as { code?: string }).code;
        const msg = (data as { message?: string }).message ?? '操作失败';
        throw new Error(code ? `${code}: ${msg}` : msg);
      }
      return data as { ok: boolean; action?: string; noop?: boolean };
    },
    onSuccess: (res) => {
      setActionError(null);
      if (!res.noop) {
        queryClient.invalidateQueries({ queryKey: ['admin-users'] });
        queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
      }
    },
    onError: (err) => setActionError((err as Error).message),
  });

  const inviteMut = useMutation({
    mutationFn: async (email: string) => {
      const r = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await r.json().catch(() => ({})) as {
        message?: string;
        noop?: boolean;
        email?: string;
      };
      if (!r.ok) throw new Error(data.message ?? '添加白名单失败');
      return data;
    },
    onSuccess: (data) => {
      setActionError(null);
      setInviteEmail('');
      setInviteNotice(data.noop ? `${data.email ?? '该邮箱'} 已在白名单中` : `${data.email ?? '该邮箱'} 已加入白名单`);
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
    onError: (err) => {
      setInviteNotice(null);
      setActionError((err as Error).message);
    },
  });

  if (q.isLoading) return <QueueSkeleton />;
  if (q.isError) return <Box component="p" sx={{"fontSize":"var(--dr-type-body)","color":"error.main"}}>{(q.error as Error).message}</Box>;
  const items = q.data?.items ?? [];
  return (
    <div>
      <Box component="form"
        sx={{"mb":2,"display":"flex","flexDirection":"column","gap":1,"borderBottom":"1px solid var(--dr-color-outline)","borderColor":"divider","pb":2,"@media (min-width:640px)":{"flexDirection":"row","alignItems":"flex-end"}}}
        onSubmit={(event) => {
          event.preventDefault();
          setActionError(null);
          setInviteNotice(null);
          inviteMut.mutate(inviteEmail);
        }}
      >
        <Box component="div" sx={{"minWidth":0,"flex":"1 1 0%"}}>
          <Box component="p" sx={{"fontSize":"var(--dr-type-body)","fontWeight":"var(--dr-weight-medium)"}}>Beta 注册白名单</Box>
          <Box component="p" sx={{"mt":0.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>添加后，该邮箱可通过密码注册或 OAuth 首次登录。</Box>
          <Input
            sx={{"mt":1,"maxWidth":448}}
            type="email"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            placeholder="name@example.com"
            aria-label="允许注册的邮箱"
            required
            disabled={inviteMut.isPending}
          />
        </Box>
        <Button type="submit" variant="outline" disabled={inviteMut.isPending || !inviteEmail.trim()}>
          <Box component={UserPlus} sx={{"width":16,"height":16}} aria-hidden />
          {inviteMut.isPending ? '添加中…' : '添加邮箱'}
        </Button>
      </Box>
      {actionError ? (
        <Box component="p" sx={{"mb":1,"fontSize":"var(--dr-type-caption)","color":"error.main"}} role="alert">操作失败：{actionError}</Box>
      ) : null}
      {inviteNotice ? <Box component="p" sx={{"mb":1,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}} role="status">{inviteNotice}</Box> : null}
      {items.length === 0 ? (
        <EmptyState title="还没有成员" description="先添加一个允许注册的邮箱。" />
      ) : <Card>
        <CardContent sx={{"p":0}}>
          <Box role="region" aria-label="成员列表" tabIndex={0} sx={{ overflowX: 'auto' }}>
          <Box component="table" sx={{ width: '100%', minWidth: 880, fontSize: 'var(--dr-type-body)', '& th, & td': { whiteSpace: 'nowrap' } }}>
            <Box component="thead" sx={{"backgroundColor":"color-mix(in srgb, var(--dr-color-surface-container) 40%, var(--dr-color-surface))","textAlign":"left","fontSize":"var(--dr-type-caption)","textTransform":"uppercase","letterSpacing":"0.025em","color":"text.secondary"}}>
              <tr>
                <Box component="th" sx={{"px":2,"py":1.5,"fontWeight":"var(--dr-weight-medium)"}}>姓名</Box>
                <Box component="th" sx={{"px":2,"py":1.5,"fontWeight":"var(--dr-weight-medium)"}}>邮箱</Box>
                <Box component="th" sx={{"px":2,"py":1.5,"fontWeight":"var(--dr-weight-medium)"}}>角色</Box>
                <Box component="th" sx={{"px":2,"py":1.5,"fontWeight":"var(--dr-weight-medium)"}}>状态</Box>
                <Box component="th" sx={{"px":2,"py":1.5,"fontWeight":"var(--dr-weight-medium)"}}>加入时间</Box>
                <Box component="th" sx={{"px":2,"py":1.5,"fontWeight":"var(--dr-weight-medium)","textAlign":"right"}}>操作</Box>
              </tr>
            </Box>
            <tbody>
              {items.map((u) => {
                const isAdmin = u.role === 'admin';
                const isDisabled = !!u.disabledAt;
                return (
                  <Box component="tr" key={u.id} sx={{"borderTop":"1px solid var(--dr-color-outline)","borderColor":"divider","transition":"color, background-color, border-color var(--dr-motion-fast)","&:hover":{"backgroundColor":"color-mix(in srgb, var(--dr-color-surface-container) 30%, var(--dr-color-surface))"}}}>
                    <Box component="td" sx={{"px":2,"py":1.5}}>{u.name || '—'}</Box>
                    <Box component="td" sx={{"px":2,"py":1.5,"fontFamily":"monospace","fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>{u.email}</Box>
                    <Box component="td" sx={{"px":2,"py":1.5}}><Badge variant={isAdmin ? 'destructive' : 'secondary'}>{isAdmin ? '管理员' : '成员'}</Badge></Box>
                    <Box component="td" sx={{"px":2,"py":1.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>{isDisabled ? '已禁用' : '正常'}</Box>
                    <Box component="td" sx={{"px":2,"py":1.5,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>{new Date(u.createdAt).toLocaleDateString('zh-CN')}</Box>
                    <Box component="td" sx={{"px":2,"py":1.5}}>
                      <Box component="div" sx={{"display":"flex","justifyContent":"flex-end","gap":1}}>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={updateMut.isPending || (isAdmin && !isDisabled)}
                          onClick={() => updateMut.mutate({ id: u.id, body: { role: 'admin' } })}
                        >
                          <Box component={ShieldCheck} sx={{"width":12,"height":12}} />
                          设为管理员
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={updateMut.isPending || (!isAdmin && !isDisabled)}
                          onClick={() => updateMut.mutate({ id: u.id, body: { role: 'member' } })}
                        >
                          降为成员
                        </Button>
                        {isDisabled ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={updateMut.isPending}
                            onClick={() => updateMut.mutate({ id: u.id, body: { disabled: false } })}
                          >
                            恢复
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            sx={{"color":"error.main"}}
                            disabled={updateMut.isPending}
                            onClick={() => updateMut.mutate({ id: u.id, body: { disabled: true } })}
                          >
                            禁用
                          </Button>
                        )}
                      </Box>
                    </Box>
                  </Box>
                );
              })}
            </tbody>
          </Box>
          </Box>
        </CardContent>
      </Card>}
      <Box component="p" sx={{"mt":1,"fontSize":"var(--dr-type-caption)","color":"text.secondary"}}>
        所有变更落 admin_actions 审计日志；最后一个 active admin 不能降级或禁用。
      </Box>
    </div>
  );
}
