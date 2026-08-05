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
//   - 只在登录后展示（getCurrentUser 由父 server 组件传入 null 时整块不挂）。

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
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
  if (tier === 'collection') return '收藏';
  return null;
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

  const latestDigest = digestQ.data?.dates[0];
  const latestRadar = (radarQ.data?.items ?? []).slice(0, 3);

  const loading = digestQ.isLoading || radarQ.isLoading;

  // 两路全空 → 整块不渲染（empty = direction, not mood）
  if (!loading && !latestDigest && latestRadar.length === 0) return null;

  return (
    <section
      aria-label="今日研究概览"
      className="mt-5 grid min-w-0 gap-3 overflow-hidden rounded-lg border border-border bg-card p-4"
    >
      {loading ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <div className="grid min-w-0 gap-3 lg:grid-cols-[1.35fr_1fr]">
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

          {/* 次条：3 条今日高信号 */}
          {latestRadar.length > 0 && (
            <div className="min-w-0 rounded-md border border-border bg-card p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <RadarIcon className="size-3" />
                今日高信号 ({latestRadar.length})
              </div>
              <ul className="mt-1.5 space-y-1">
                {latestRadar.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/radar/${c.id}`}
                      className="group/signal flex min-w-0 items-start gap-1.5 rounded px-1 py-1 text-xs hover:bg-accent/40"
                      title={c.title}
                    >
                      <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground">
                        {c.sourceType ?? '·'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate group-hover/signal:text-primary">{c.title}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {c.interpretation ?? '进入详情查看 AI 解读'}
                        </span>
                      </span>
                      <span className="shrink-0 text-right font-mono text-[10px] text-muted-foreground">
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
    </section>
  );
}
