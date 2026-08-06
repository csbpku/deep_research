'use client';

// 首页"今日研究概览" —— 给工程师一个 5 秒决策入口。
//
// 设计依据：
//   - 用户场景：工程师来平台要么"扫一眼今天"要么"找昨天的研究"。
//     没有任何事件展示时，他们必须先点日报或雷达 —— 多一步摩擦。
//   - 数据源：复用 /api/summaries 和 /api/radar 的现有接口；
//     拉最近 1 条已发布日报标题 + 按 Distilled 分数排序的 3 条高信号。
//   - 加载策略：客户端拉取；空数据时整块不渲染（不展示"没有东西"的占位 ——
//     数据库规则 #8 提到"empty is direction, not mood"）。
//   - 团队区拆成两块独立 section：
//       · "进行中的调研" — 登录用户可见，展示 running/queued AI jobs
//       · "待审核"      — 仅 admin 可见，展示 pending shares / comment nominations

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CheckSquare,
  Clock3,
  Newspaper,
  Radar as RadarIcon,
} from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';

interface DigestItem {
  summaryId: string;
  date: string;
  title: string;
  publishedAt: string | null;
  candidateCount: number;
}

interface DigestListResponse {
  dates: DigestItem[];
  total: number;
}

interface RadarCandidateItem {
  id: string;
  title: string;
  sourceType: string | null;
  crawledAt: string;
  interpretation: string | null;
  distilledScore: {
    tier?: string;
    rankingScore?: number;
    effectiveTotal?: number;
    total?: number;
  } | null;
}

interface RadarListResponse {
  items: RadarCandidateItem[];
  total: number;
}

interface AiJobsResponse {
  items: Array<{ jobId: string; topic: string; status: string }>;
}

interface AdminDashboardResponse {
  pendingReviews: {
    total: number;
    shares: number;
    commentNominations: number;
  };
}

function formatTimeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

function scoreValue(score: RadarCandidateItem['distilledScore']): number | null {
  if (!score) return null;
  return score.rankingScore ?? score.effectiveTotal ?? score.total ?? null;
}

function tierLabel(tier: string | undefined): string | null {
  if (tier === 'deep_read') return '深度阅读';
  if (tier === 'skim') return '略读';
  if (tier === 'collection') return '重点阅读';
  return null;
}

export function RecentActivityStrip({
  loggedIn,
  isAdmin,
}: {
  loggedIn: boolean;
  isAdmin: boolean;
}) {
  const digestQ = useQuery<DigestListResponse>({
    queryKey: ['home', 'digest'],
    queryFn: async () => {
      const r = await fetch('/api/summaries?limit=3', { cache: 'no-store' });
      if (!r.ok) return { dates: [], total: 0 };
      return r.json();
    },
    staleTime: 60_000,
  });

  const radarQ = useQuery<RadarListResponse>({
    queryKey: ['home', 'radar'],
    queryFn: async () => {
      const r = await fetch('/api/radar?quality=relevant&per_page=3', { cache: 'no-store' });
      if (!r.ok) return { items: [], total: 0 };
      return r.json();
    },
    staleTime: 60_000,
  });

  const jobsQ = useQuery<AiJobsResponse>({
    queryKey: ['home', 'ai-jobs'],
    queryFn: async () => {
      const r = await fetch('/api/ai-research/jobs?status=queued,running&limit=2', { cache: 'no-store' });
      if (!r.ok) return { items: [] };
      return r.json();
    },
    staleTime: 30_000,
    enabled: loggedIn,
  });

  const teamQ = useQuery<AdminDashboardResponse>({
    queryKey: ['home', 'admin-dashboard'],
    queryFn: async () => {
      const r = await fetch('/api/admin/dashboard', { cache: 'no-store' });
      if (!r.ok) {
        return { pendingReviews: { total: 0, shares: 0, commentNominations: 0 } };
      }
      return r.json();
    },
    staleTime: 30_000,
    enabled: isAdmin,
  });

  const latestDigest = digestQ.data?.dates[0];
  const latestRadar = (radarQ.data?.items ?? []).slice(0, 3);

  const runningJobs = jobsQ.data?.items ?? [];
  const pendingShares = teamQ.data?.pendingReviews.shares ?? 0;
  const pendingCommentNominations = teamQ.data?.pendingReviews.commentNominations ?? 0;
  const hasRunningJobs = loggedIn && runningJobs.length > 0;
  const hasPendingReviews = isAdmin && (pendingShares > 0 || pendingCommentNominations > 0);

  const loading = digestQ.isLoading || radarQ.isLoading || jobsQ.isLoading || teamQ.isLoading;

  // 主面板全空 → 整块不渲染（empty = direction, not mood）
  if (!loading && !latestDigest && latestRadar.length === 0) return null;

  return (
    <section aria-label="今日研究概览" className="mt-5 grid min-w-0 grid-cols-1 gap-4">
      {loading ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.95fr)]">
          {/* 主条：最新日报 */}
          {latestDigest && (
            <Link
              href={`/summaries/${latestDigest.date}`}
              className="group flex min-h-64 min-w-0 flex-col justify-between rounded-lg border border-border bg-gradient-to-br from-card via-card to-accent/35 p-6 transition-colors duration-200 hover:border-primary/40 hover:to-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-primary">
                <Newspaper className="size-3" />
                  最新日报 · 今日看点
                </div>
                <h3 className="mt-4 max-w-xl text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
                {latestDigest.title}
                </h3>
                <p className="mt-3 max-w-xl text-sm leading-7 text-muted-foreground">
                  把跨来源信号组织成今天值得先读的结论、证据和下一步问题。
                </p>
              </div>
              <div className="mt-6 flex items-center justify-between gap-3 border-t border-border pt-3">
                <p className="font-mono text-[11px] text-muted-foreground">
                {latestDigest.date} · {latestDigest.candidateCount} 条信号 ·{' '}
                {formatTimeAgo(latestDigest.publishedAt)}
                </p>
                <span className="text-xs font-medium text-primary">阅读今日日报 <ArrowRight className="ml-1 inline size-3.5 transition-transform group-hover:translate-x-0.5" /></span>
              </div>
            </Link>
          )}

          {/* 次条：3 条今日高信号 */}
          {latestRadar.length > 0 && (
            <div className="min-w-0 rounded-lg border border-border bg-card p-5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <RadarIcon className="size-3" />
                  今日高信号
                </div>
                <span className="font-mono text-[11px] text-muted-foreground">按价值排序 · {latestRadar.length} 条</span>
              </div>
              <ul className="mt-3 divide-y divide-border">
                {latestRadar.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/radar/${c.id}`}
                      className="group/signal flex min-w-0 items-start gap-3 py-3 text-xs hover:text-primary"
                      title={c.title}
                    >
                      <span className="mt-0.5 shrink-0 font-mono text-xs text-primary">
                        {String(latestRadar.indexOf(c) + 1).padStart(2, '0')}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate group-hover/signal:text-primary">{c.title}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {c.interpretation ?? '进入详情查看 AI 解读'}
                        </span>
                      </span>
                      <span className="shrink-0 text-right font-mono text-xs text-status-succeeded-fg">
                        {scoreValue(c.distilledScore) ?? '—'}
                        {tierLabel(c.distilledScore?.tier) ? (
                          <span className="ml-1 font-sans">{tierLabel(c.distilledScore?.tier)}</span>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

        </div>
      )}

      {/* 进行中的调研 — 仅登录用户、且有 running jobs 时显示 */}
      {!loading && hasRunningJobs ? (
        <section className="rounded-lg border border-border bg-card p-4" aria-label="进行中的调研">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Clock3 className="size-3.5 text-primary" />
              进行中的调研
            </h2>
            <Link href="/ai-research" className="font-mono text-[11px] text-muted-foreground hover:text-primary">
              查看全部
            </Link>
          </div>
          <ul className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            {runningJobs.map((job) => (
              <li key={job.jobId}>
                <Link
                  href={`/ai-research/${job.jobId}`}
                  className="flex min-w-0 items-center gap-2 rounded-md bg-accent/60 px-3 py-2 text-xs hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate">AI 调研 · {job.topic}</span>
                  <span className="text-primary">进行中</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 待审核 — 仅 admin、且有 pending review 时显示 */}
      {!loading && hasPendingReviews ? (
        <section className="rounded-lg border border-border bg-card p-4" aria-label="待审核">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <CheckSquare className="size-3.5 text-primary" />
              待审核
            </h2>
            <Link href="/admin" className="font-mono text-[11px] text-muted-foreground hover:text-primary">
              进入管理
            </Link>
          </div>
          <ul className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            {pendingCommentNominations > 0 ? (
              <li>
                <Link
                  href="/admin?tab=comments"
                  className="flex min-w-0 items-center gap-2 rounded-md bg-muted/70 px-3 py-2 text-xs hover:bg-muted"
                >
                  <span className="min-w-0 flex-1 truncate">
                    评论提炼 · {pendingCommentNominations} 条待处理
                  </span>
                  <span className="text-muted-foreground">处理</span>
                </Link>
              </li>
            ) : null}
            {pendingShares > 0 ? (
              <li>
                <Link
                  href="/admin?tab=shares"
                  className="flex min-w-0 items-center gap-2 rounded-md bg-muted/70 px-3 py-2 text-xs hover:bg-muted"
                >
                  <span className="min-w-0 flex-1 truncate">
                    分享审核 · {pendingShares} 条待处理
                  </span>
                  <span className="text-muted-foreground">处理</span>
                </Link>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
