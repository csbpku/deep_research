'use client';

// Admin 控制台客户端组件 —— Week 8：仪表板 + 调研库管理 + 3 个审核队列。
// 由 app/admin/page.tsx（Server Component）做鉴权拦截后渲染。

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Archive,
  CalendarDays,
  Check,
  CheckCircle2,
  DollarSign,
  Eye,
  Library,
  Lightbulb,
  Link2,
  LoaderCircle,
  MessageSquare,
  Newspaper,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search as SearchIcon,
  Star,
  User,
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AdminActionDialog, type AdminActionValues } from '@/components/admin/AdminActionDialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatSourceType } from '@/lib/radar/source-labels';
import { TopicProposalsTab } from '@/components/admin/TopicProposalsTab';
import { AdminTopicActions } from '@/components/topics/AdminTopicActions';

export const ADMIN_TAB_KEYS = [
  'dashboard',
  'researches',
  'topics',
  'shares',
  'comments',
  'users',
] as const;
type Tab = typeof ADMIN_TAB_KEYS[number];

const TABS: { key: Tab; label: string; icon: typeof RadarIcon }[] = [
  { key: 'dashboard', label: '仪表板', icon: ShieldCheck },
  { key: 'researches', label: '调研库', icon: Library },
  { key: 'topics', label: '主题提议', icon: Sparkles },
  { key: 'shares', label: '用户分享', icon: Link2 },
  { key: 'comments', label: '评论提名', icon: Lightbulb },
  { key: 'users', label: '成员', icon: User },
];

interface DashboardData {
  pendingReviews: { total: number; shares: number; commentNominations: number };
  content: { newResearchesThisWeek: number };
  jobs: { submittedLast24h: number; failedLast24h: number; failedImportJobs: number };
  cost: { monthUsdCents: number; monthUsd: string };
  radar: {
    lastSync: null | {
      id: string;
      source: { name: string; sourceType: string } | null;
      status: string;
      completedAt: string | null;
      createdAt: string;
      errorCode: string | null;
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
    <div className="mx-auto max-w-shell">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-normal">
          <ShieldCheck className="size-5 text-destructive" />
          Admin 控制台
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理内容质量、监控平台健康度。仅 admin 角色可见。
        </p>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="w-full justify-start overflow-x-auto">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <TabsTrigger key={t.key} value={t.key} className="shrink-0 whitespace-nowrap">
                <Icon className="size-4" />
                {t.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      <div className="mt-4">
        {tab === 'dashboard' && <DashboardTab />}
        {tab === 'researches' && <ResearchesTab />}
        {tab === 'topics' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-card p-4">
              <div>
                <h2 className="text-sm font-semibold">主题运营</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  主题提议在下方审核队列生成并审核；这里仅负责对已发布主题生成 AI 综述。
                </p>
              </div>
              <AdminTopicActions />
            </div>
            <TopicProposalsTab />
          </div>
        )}
        {tab === 'shares' && <SharesTab />}
        {tab === 'comments' && <CommentsTab />}
        {tab === 'users' && <UsersTab />}
      </div>
    </div>
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
    <div className="mb-3 flex flex-wrap items-center gap-1">
      {options.map((o) => (
        <Button
          key={o.key}
          type="button"
          variant={value === o.key ? 'default' : 'outline'}
          size="xs"
          className="rounded-full"
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </Button>
      ))}
      {trailing ? (
        <div className="ml-auto text-xs text-muted-foreground">{trailing}</div>
      ) : null}
    </div>
  );
}

function QueueSkeleton() {
  return (
    <div className="grid gap-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
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
  const q = useQuery<DashboardData>({
    queryKey: ['admin-dashboard'],
    queryFn: async () => {
      const r = await fetch('/api/admin/dashboard', { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
    refetchInterval: 30_000,
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
      setRadarActionMessage('雷达同步已提交，完成后将自动生成日报');
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['admin-radar-runs'] });
    },
    onError: (error) => {
      setRadarActionMessage((error as Error).message);
    },
  });
  const digestMut = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/admin/radar/digest', { method: 'POST' });
      if (response.status === 409) {
        throw new Error('已有同步任务进行中，请等待完成后再试');
      }
      if (!response.ok) throw new Error('日报任务提交失败');
      return response.json();
    },
    onSuccess: () => {
      setRadarActionMessage('今日日报重新生成任务已提交');
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
    onError: (error) => {
      setRadarActionMessage((error as Error).message);
    },
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
  const sortedRuns = useMemo(() => {
    const statusRank: Record<string, number> = {
      running: 0,
      failed: 1,
      partial: 2,
      completed: 3,
    };
    return [...latestRuns].sort((a, b) => {
      const statusDelta = (statusRank[a.status] ?? 4) - (statusRank[b.status] ?? 4);
      if (statusDelta !== 0) return statusDelta;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [latestRuns]);
  const visibleRuns = useMemo(() => sortedRuns.filter((run) => {
    if (runFilter === 'attention') {
      return run.status === 'running' || run.status === 'partial' || run.status === 'failed';
    }
    if (runFilter === 'new') return run.totalNew > 0;
    return true;
  }), [runFilter, sortedRuns]);
  const attentionCount = runSummary.running + runSummary.partial + runSummary.failed;

  if (q.isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }
  if (q.isError || !q.data) {
    return <p className="text-sm text-destructive">{(q.error as Error)?.message ?? '加载失败'}</p>;
  }

  const d = q.data;

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-2 xl:grid-cols-4">
        <StatCard
          label={
            <span className="inline-flex items-center gap-1">
              <Timer className="size-3" />
              待处理
            </span>
          }
          value={d.pendingReviews.total}
          hint={
            <span>
              分享 {d.pendingReviews.shares} · 待提炼 {d.pendingReviews.commentNominations}
            </span>
          }
          tone={d.pendingReviews.total > 0 ? 'primary' : 'default'}
          className="p-3"
        />
        <StatCard
          label={
            <span className="inline-flex items-center gap-1">
              <Library className="size-3" />
              本周新增
            </span>
          }
          value={d.content.newResearchesThisWeek}
          hint="已发布调研库"
          className="p-3"
        />
        <StatCard
          label={
            <span className="inline-flex items-center gap-1">
              <Sparkles className="size-3" />
              AI 调研
            </span>
          }
          value={`${d.jobs.submittedLast24h} / 24h`}
          hint={`失败 ${d.jobs.failedLast24h} · 导入失败 ${d.jobs.failedImportJobs}`}
          className="p-3"
        />
        <StatCard
          label={
            <span className="inline-flex items-center gap-1">
              <DollarSign className="size-3" />
              本月成本
            </span>
          }
          value={`$${d.cost.monthUsd}`}
          hint="AI 调研"
          className="p-3"
        />
      </div>

      <section className="overflow-hidden rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <RadarIcon className="size-4 text-muted-foreground" />
                雷达同步
              </h2>
              <RadarHealthBadge
                running={runSummary.running}
                failed={runSummary.failed}
                partial={runSummary.partial}
                pending={runSummary.pendingScore + runSummary.pendingEnrichment}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              同步、评分与内容补全的逐源运行状态
            </p>
          </div>
          <div className="grid w-full grid-cols-2 items-end gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
            <label className="col-span-2 grid gap-1 text-xs text-muted-foreground sm:col-span-1">
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="size-3.5" />
                查看日期
              </span>
              <Input
                type="date"
                value={radarDate}
                max={shanghaiDateValue()}
                className="h-8 w-full text-xs sm:w-[148px]"
                onChange={(event) => {
                  setRadarDate(event.target.value || shanghaiDateValue());
                  setRunFilter('all');
                }}
              />
            </label>
            <Button
              type="button"
              size="sm"
              className="w-full sm:w-auto"
              disabled={syncMut.isPending || digestMut.isPending || syncInFlight}
              onClick={() => syncMut.mutate()}
            >
              <RefreshCw className={cn('size-4', syncMut.isPending && 'animate-spin')} />
              启动今日同步
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full sm:w-auto"
              disabled={syncMut.isPending || digestMut.isPending || syncInFlight}
              onClick={() => digestMut.mutate()}
            >
              <Newspaper className={cn('size-4', digestMut.isPending && 'animate-pulse')} />
              重生成今日日报
            </Button>
          </div>
        </div>
        {radarActionMessage ? (
          <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground" aria-live="polite">
            {radarActionMessage}
          </p>
        ) : null}
        {syncInFlight ? (
          <div
            className="flex items-center gap-2 border-b border-status-running-fg/20 bg-status-running-bg/50 px-4 py-2 text-xs text-status-running-fg"
            aria-live="polite"
          >
            <LoaderCircle className="size-3.5 animate-spin" />
            当前同步正在运行，完成后会自动刷新状态并生成日报。
          </div>
        ) : null}
        {runsQ.isLoading ? (
          <div className="grid gap-2 p-4">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : runsQ.isError ? (
          <p className="p-4 text-sm text-destructive">{(runsQ.error as Error).message}</p>
        ) : latestRuns.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">该日期暂无同步记录</p>
        ) : (
          <>
            <div className="grid grid-cols-2 border-b border-border bg-muted/20 sm:grid-cols-3 xl:grid-cols-6">
              <RadarMetric label="信息源" value={latestRuns.length} />
              <RadarMetric label="完成" value={runSummary.completed} tone="success" />
              <RadarMetric label="异常" value={attentionCount} tone={attentionCount > 0 ? 'danger' : 'default'} />
              <RadarMetric label="新增" value={`+${runSummary.totalNew}`} tone="success" />
              <RadarMetric label="待评分" value={runSummary.pendingScore} tone={runSummary.pendingScore > 0 ? 'warning' : 'default'} />
              <RadarMetric label="待补全" value={runSummary.pendingEnrichment} tone={runSummary.pendingEnrichment > 0 ? 'warning' : 'default'} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
              <div className="inline-flex overflow-hidden rounded-md border border-border bg-background">
                {([
                  ['all', `全部 ${latestRuns.length}`],
                  ['attention', `异常 ${attentionCount}`],
                  ['new', `有新增 ${latestRuns.filter((run) => run.totalNew > 0).length}`],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={runFilter === key}
                    className={cn(
                      'h-7 border-r border-border px-2.5 text-xs transition-colors last:border-r-0',
                      runFilter === key
                        ? 'bg-foreground font-medium text-background'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                    onClick={() => setRunFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">
                {visibleRuns.length} 个结果
              </span>
            </div>

            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[820px] text-left text-xs">
                <thead className="border-b border-border bg-muted/10 text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">信息源</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">同步结果</th>
                    <th className="px-3 py-2 font-medium">后处理</th>
                    <th className="px-4 py-2 font-medium">耗时 / 问题</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visibleRuns.map((run) => (
                    <tr
                      key={run.sourceId}
                      className={cn(
                        'align-middle transition-colors hover:bg-muted/20',
                        run.status === 'failed' && 'bg-destructive/[0.035]',
                        run.status === 'partial' && 'bg-amber-500/[0.035]',
                      )}
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-foreground">{run.sourceName}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
                          <span>{formatSourceType(run.sourceType).short}</span>
                          <span aria-hidden="true">·</span>
                          <span>{run.triggeredBy === 'cron' ? '定时' : '手动'}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <SyncStatusBadge status={run.status} />
                        <div className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                          {formatRunTime(run.completedAt ?? run.createdAt)}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="font-mono tabular-nums text-foreground">
                          {run.totalFetched}
                          <span className="ml-1 font-sans text-muted-foreground">抓取</span>
                          <span className="ml-2 text-emerald-700 dark:text-emerald-300">+{run.totalNew}</span>
                        </div>
                        {run.totalFailed > 0 ? (
                          <div className="mt-1 text-destructive">失败 {run.totalFailed}</div>
                        ) : (
                          <div className="mt-1 text-muted-foreground">跳过 {run.totalSkipped}</div>
                        )}
                      </td>
                      <td className="w-[210px] px-3 py-2.5">
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
                      </td>
                      <td className="max-w-[240px] px-4 py-2.5 text-muted-foreground">
                        <div className="font-mono tabular-nums">{formatElapsed(run.elapsedMs)}</div>
                        {run.errorCode ? (
                          <div className="mt-1 whitespace-normal break-words text-[11px] text-destructive">
                            <code>{run.errorCode}</code>
                            {run.errorMessage ? <div className="mt-0.5 font-sans">{run.errorMessage}</div> : null}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-border md:hidden">
              {visibleRuns.map((run) => (
                <div
                  key={run.sourceId}
                  className={cn(
                    'px-4 py-3',
                    run.status === 'failed' && 'bg-destructive/[0.035]',
                    run.status === 'partial' && 'bg-amber-500/[0.035]',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{run.sourceName}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {formatSourceType(run.sourceType).short} · {run.triggeredBy === 'cron' ? '定时' : '手动'} · {formatRunTime(run.completedAt ?? run.createdAt)}
                      </div>
                    </div>
                    <SyncStatusBadge status={run.status} />
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
                    <div>
                      <div className="text-muted-foreground">同步</div>
                      <div className="mt-0.5 font-mono tabular-nums">
                        {run.totalFetched} / <span className="text-emerald-700 dark:text-emerald-300">+{run.totalNew}</span>
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">评分</div>
                      <div className="mt-0.5 font-mono tabular-nums">{stageCount(run.scoredCount, run.candidateCount)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">补全</div>
                      <div className="mt-0.5 font-mono tabular-nums">{stageCount(run.enrichedCount, run.candidateCount)}</div>
                    </div>
                  </div>
                  {run.errorCode ? (
                    <div className="mt-2 break-words text-[11px] text-destructive">
                      <code>{run.errorCode}</code>
                      {run.errorMessage ? <div className="mt-0.5 text-xs">{run.errorMessage}</div> : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <p className="mt-4 text-xs text-muted-foreground">
        数据生成时间：{new Date(d.generatedAt).toLocaleString('zh-CN')} · 每 30s 自动刷新
      </p>
    </div>
  );
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
      <span className="inline-flex items-center gap-1 rounded-full bg-status-running-bg px-2 py-0.5 text-[11px] font-medium text-status-running-fg">
        <Activity className="size-3" />
        同步中
      </span>
    );
  }
  if (failed > 0 || partial > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-status-failed-bg px-2 py-0.5 text-[11px] font-medium text-status-failed-fg">
        <AlertTriangle className="size-3" />
        有异常
      </span>
    );
  }
  if (pending > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-status-partial-bg px-2 py-0.5 text-[11px] font-medium text-status-partial-fg">
        <Activity className="size-3" />
        后处理中
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-status-succeeded-bg px-2 py-0.5 text-[11px] font-medium text-status-succeeded-fg">
      <CheckCircle2 className="size-3" />
      已完成
    </span>
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
    <div className="px-4 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-0.5 font-mono text-lg font-semibold tabular-nums',
          tone === 'default' && 'text-foreground',
          tone === 'success' && 'text-emerald-700 dark:text-emerald-300',
          tone === 'warning' && 'text-amber-700 dark:text-amber-300',
          tone === 'danger' && 'text-destructive',
        )}
      >
        {value}
      </div>
    </div>
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
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-mono tabular-nums',
          complete && 'text-emerald-700 dark:text-emerald-300',
          pending > 0 && 'text-amber-700 dark:text-amber-300',
        )}
      >
        {stageCount(completed, total)}
      </span>
    </div>
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
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', s.className)}>
      {s.label}
    </span>
  );
}

/**
 * Pure helper：雷达同步状态 → 中文 label + token 化配色 class。
 * 导出供单测使用（项目未装 @testing-library/react，只测纯函数）。
 */
export function syncStatusStyle(status: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    running: { label: '运行中', className: 'bg-status-running-bg text-status-running-fg' },
    completed: { label: '完成', className: 'bg-status-succeeded-bg text-status-succeeded-fg' },
    partial: { label: '部分', className: 'bg-status-partial-bg text-status-partial-fg' },
    failed: { label: '失败', className: 'bg-status-failed-bg text-status-failed-fg' },
  };
  return map[status] ?? { label: status, className: 'bg-muted text-muted-foreground' };
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
      {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

      <ul className="grid list-none gap-2.5 p-0">
        {(q.data?.items ?? []).map((it) => (
          <li key={it.id}>
            <Card className="transition-colors duration-200 hover:border-primary/40">
              <CardContent className="p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold">
                  <a
                    href={it.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-primary hover:underline"
                  >
                    {it.fetchedTitle ?? it.url}
                  </a>
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  分享人：{it.submitter.name}（{it.submitter.email}） ·{' '}
                  {new Date(it.createdAt).toLocaleString('zh-CN')}
                </p>
                {it.userNote && (
                  <p className="mt-1.5 flex items-start gap-1.5 rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                    <MessageSquare className="mt-0.5 size-3 shrink-0" />
                    {it.userNote}
                  </p>
                )}
                {it.summaryText && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-primary">查看 AI 摘要</summary>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                      {it.summaryText.slice(0, 500)}
                      {it.summaryText.length > 500 && '…'}
                    </p>
                  </details>
                )}
                {it.fetchErrorCode && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                    <AlertTriangle className="size-3" />
                    抓取失败：{it.fetchErrorCode}
                  </p>
                )}
              </div>
              {status === 'pending' && (
                <div className="flex shrink-0 flex-col gap-1.5">
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
                    className="text-destructive"
                    disabled={reviewMut.isPending}
                    onClick={() => setRejectingShare({ id: it.id, title: it.fetchedTitle ?? it.url })}
                  >
                    <X />
                    拒绝
                  </Button>
                </div>
              )}
            </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {reviewMut.isError && (
        <p className="mt-2 text-xs text-destructive">
          操作失败：{(reviewMut.error as Error).message}
        </p>
      )}

      <AdminActionDialog
        open={!!rejectingShare}
        onOpenChange={(o) => !o && setRejectingShare(null)}
        title="拒绝分享"
        description={rejectingShare ? <>分享：<strong className="font-medium text-foreground">{rejectingShare.title}</strong></> : undefined}
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
      {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

      <ul className="grid list-none gap-2.5 p-0">
        {(q.data?.items ?? []).map((it) => (
          <li key={it.id}>
            <Card className="transition-colors duration-200 hover:border-primary/40">
              <CardContent className="p-3.5">
                <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <strong className="font-medium text-foreground">{it.author.name}</strong>（
              {it.author.email}） · {new Date(it.createdAt).toLocaleString('zh-CN')} ·
              <span className="inline-flex items-center gap-0.5">
                <Sparkles className="size-3" />
                {it.starCount}
              </span>
              {it.targetType === 'summary' && it.summary && (
                <>
                  · 来自摘要:
                  <Link href={`/summaries/${it.summary.id}`} className="text-primary hover:underline">
                    {it.summary.title}
                  </Link>
                </>
              )}
              {it.targetType === 'research' && it.research && (
                <>
                  · 来自调研库:
                  <Link
                    href={`/researches/${it.research.id}`}
                    className="text-primary hover:underline"
                  >
                    {it.research.title}
                  </Link>
                </>
              )}
            </p>

            <blockquote className="my-2 rounded-r border-l-2 border-l-primary bg-muted/50 px-3 py-2 text-sm leading-relaxed">
              {it.body}
            </blockquote>

            {it.promoteStatus === 'nominated' && (
              <div className="flex gap-2">
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
                  className="text-destructive"
                  disabled={dismissMut.isPending}
                  onClick={() => setDismissingComment({ id: it.id, excerpt: it.body.slice(0, 80) })}
                >
                  <X />
                  拒绝
                </Button>
              </div>
            )}
            {it.promoteStatus === 'approved' && (
              <p className="flex items-center gap-1 text-xs text-status-succeeded-fg">
                <CheckCircle2 className="size-3.5" />
                已提炼为知识卡片
              </p>
            )}
            {it.promoteStatus === 'rejected' && (
              <p className="text-xs text-muted-foreground">已拒绝</p>
            )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

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
        description={dismissingComment ? <>评论原文：<span className="text-foreground">{dismissingComment.excerpt}{dismissingComment.excerpt.length === 80 ? '…' : ''}</span></> : undefined}
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
// 调研库管理
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

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <form
          className="flex min-w-[220px] flex-1 gap-1.5 sm:max-w-md"
          onSubmit={(e) => {
            e.preventDefault();
            setAppliedQuery(searchText.trim());
            setPage(1);
          }}
        >
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="搜索标题、正文或标签…"
              aria-label="搜索调研库"
              className="pl-9"
            />
          </div>
          <Button type="submit" size="sm" variant="outline" className="shrink-0">
            <SearchIcon />
            搜索
          </Button>
        </form>

        <Select
          value={type}
          onValueChange={(next) => {
            setType(next as AdminResearchType);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-36" aria-label="内容类型">
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
      </div>

      {q.isLoading && <QueueSkeleton />}
      {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

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

      <ul className="grid list-none gap-2.5 p-0">
        {(q.data?.items ?? []).map((item) => (
          <li key={item.id}>
            <Card className="transition-colors duration-200 hover:border-primary/40">
              <CardContent className="p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                      <StatusBadge kind="method" value={item.creationMethod} />
                      <StatusBadge kind="research" value={item.status} />
                      <span className="text-xs text-muted-foreground">
                        {item.type === 'research' ? '研究报告' : '知识卡片'}
                      </span>
                      {item.featuredAt && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                          <Star className="size-3" />
                          精华
                        </span>
                      )}
                    </div>

                    <Link
                      href={`/researches/${item.id}`}
                      className="rounded-sm text-sm font-semibold leading-snug tracking-normal hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {item.title}
                    </Link>

                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {adminExcerpt(item.body, 160)}
                    </p>

                    <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span>作者：{item.author.name}</span>
                      <span className="font-mono tabular-nums">
                        {new Date(item.publishedAt ?? item.createdAt).toLocaleDateString('zh-CN')}
                      </span>
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <div className="flex gap-1.5">
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
                    </div>
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
                        <Star className={item.featuredAt ? 'fill-current' : undefined} />
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
                  </div>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {(actionMut.isError || featureMut.isError) && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          操作失败：{((actionMut.error ?? featureMut.error) as Error).message}
        </p>
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
              调研：<strong className="font-medium text-foreground">{confirming.title}</strong>
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

  if (q.isLoading) return <QueueSkeleton />;
  if (q.isError) return <p className="text-sm text-destructive">{(q.error as Error).message}</p>;
  const items = q.data?.items ?? [];
  if (items.length === 0) return <EmptyState title="还没有成员" description="成员由 SSO / 邀请注册后自动加入。" />;
  return (
    <div>
      {actionError ? (
        <p className="mb-2 text-xs text-destructive" role="alert">操作失败：{actionError}</p>
      ) : null}
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">姓名</th>
                <th className="px-4 py-2.5 font-medium">邮箱</th>
                <th className="px-4 py-2.5 font-medium">角色</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">加入时间</th>
                <th className="px-4 py-2.5 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => {
                const isAdmin = u.role === 'admin';
                const isDisabled = !!u.disabledAt;
                return (
                  <tr key={u.id} className="border-t border-border transition-colors hover:bg-muted/30">
                    <td className="px-4 py-2.5">{u.name || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{u.email}</td>
                    <td className="px-4 py-2.5"><Badge variant={isAdmin ? 'destructive' : 'secondary'}>{isAdmin ? '管理员' : '成员'}</Badge></td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{isDisabled ? '已禁用' : '正常'}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{new Date(u.createdAt).toLocaleDateString('zh-CN')}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={updateMut.isPending || (isAdmin && !isDisabled)}
                          onClick={() => updateMut.mutate({ id: u.id, body: { role: 'admin' } })}
                        >
                          <ShieldCheck className="size-3" />
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
                            className="text-destructive"
                            disabled={updateMut.isPending}
                            onClick={() => updateMut.mutate({ id: u.id, body: { disabled: true } })}
                          >
                            禁用
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">
        所有变更落 admin_actions 审计日志；最后一个 active admin 不能降级或禁用。
      </p>
    </div>
  );
}
