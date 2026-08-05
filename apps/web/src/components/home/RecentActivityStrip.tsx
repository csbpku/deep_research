'use client';

// 首页"最近 24h"事件条 —— 给工程师一个 5 秒决策入口。
//
// 设计依据：
//   - 用户场景：工程师来平台要么"扫一眼今天"要么"找昨天的研究"。
//     没有任何事件展示时，他们必须先点日报或雷达 —— 多一步摩擦。
//   - 数据源：复用 /api/summaries 和 /api/radar 的现有接口；
//     拉最近 1 条已发布日报标题 + 最近 3 条候选 + 最近 1 次 AI 调研状态。
//   - 加载策略：客户端拉取；空数据时整块不渲染（不展示"没有东西"的占位 ——
//     数据库规则 #8 提到"empty is direction, not mood"）。
//   - 只在登录后展示（getCurrentUser 由父 server 组件传入 null 时整块不挂）。

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CircleDashed,
  ExternalLink,
  Loader2,
  Newspaper,
  Radar as RadarIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

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
}

interface RadarListResponse {
  items: RadarCandidateItem[];
  total: number;
}

type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'partial';

interface AiJobItem {
  jobId: string;
  topic: string;
  status: string;
  finalStatus: string | null;
  createdAt: string | null;
  draftResearchId: string | null;
}

interface AiJobsResponse {
  items: AiJobItem[];
}

function formatTimeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function RecentActivityStrip() {
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
    queryKey: ['home', 'jobs'],
    queryFn: async () => {
      const r = await fetch('/api/ai-research/jobs?limit=5', { cache: 'no-store' });
      if (!r.ok) return { items: [] };
      return r.json();
    },
    staleTime: 60_000,
  });

  const latestDigest = digestQ.data?.dates[0];
  const latestRadar = (radarQ.data?.items ?? []).slice(0, 3);
  const inFlight = (jobsQ.data?.items ?? []).filter(
    (j) => j.status === 'queued' || j.status === 'running',
  )[0];

  const loading = digestQ.isLoading || radarQ.isLoading;

  // 三路全空 + 无 in-flight → 整块不渲染（empty = direction, not mood）
  if (!loading && !latestDigest && latestRadar.length === 0 && !inFlight) return null;

  return (
    <section
      aria-label="最近活动"
      className="mt-5 grid min-w-0 gap-3 overflow-hidden rounded-lg border border-border bg-card p-4"
    >
      {loading ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <div className="grid min-w-0 gap-3 lg:grid-cols-[1.4fr_1fr_1fr]">
          {/* 主条：最新日报 */}
          {latestDigest && (
            <Link
              href={`/summaries/${latestDigest.date}`}
              className="group flex min-w-0 flex-col rounded-md border border-border bg-muted/30 p-3 transition-colors duration-200 hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary">
                <Newspaper className="size-3" />
                最新日报
              </div>
              <h3 className="mt-1 text-sm font-semibold leading-snug">
                {latestDigest.title}
              </h3>
              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {latestDigest.date} · {latestDigest.candidateCount} 条信号 ·{' '}
                {formatTimeAgo(latestDigest.publishedAt)}
              </p>
              <ArrowRight className="mt-1 ml-auto size-3.5 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-primary" />
            </Link>
          )}

          {/* 次条：3 条最新雷达 */}
          {latestRadar.length > 0 && (
            <div className="min-w-0 rounded-md border border-border bg-card p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <RadarIcon className="size-3" />
                雷达最新 ({latestRadar.length})
              </div>
              <ul className="mt-1.5 space-y-1">
                {latestRadar.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/radar/${c.id}`}
                      className="flex items-center gap-1 truncate text-xs hover:text-primary hover:underline"
                      title={c.title}
                    >
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {c.sourceType ?? '·'}
                      </span>
                      <span className="truncate">{c.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 第三条：在跑的调研（高优） */}
          {inFlight && (
            <Link
              href={`/ai-research/${inFlight.jobId}`}
              className="group flex min-w-0 flex-col rounded-md border border-status-running-fg/30 bg-status-running-bg/30 p-3 transition-colors duration-200 hover:border-status-running-fg/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-status-running-fg">
                <Loader2 className="size-3 animate-spin" />
                调研进行中
              </div>
              <p className="mt-1 line-clamp-2 text-xs font-medium leading-snug">
                {inFlight.topic}
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                {formatTimeAgo(inFlight.createdAt)} ·{' '}
                <StatusBadge
                  kind="job"
                  value={inFlight.status}
                  icon={<CircleDashed className="size-3" />}
                />
              </p>
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
