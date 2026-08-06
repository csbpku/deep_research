'use client';

// 首页"我关注的主题" —— 登录态展示 ≤ 5 个关注的主题。
//
// 数据源：/api/me/topics（仅返回当前用户关注的主题）。
// 该路由内部 requireUser，所以本组件仅在登录态挂载即可。

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Flame, Pin, Sparkles, TrendingUp, type LucideIcon } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { SectionCard } from '@/components/domain/SectionCard';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

interface FollowedTopic {
  followId: string;
  followedAt: string;
  topic: {
    id: string;
    slug: string;
    name: string;
    summary: string | null;
    tier: string;
    candidateCount: number;
    sourceCount: number;
    lastSyncedAt: string | null;
  };
}

interface FollowedTopicsResponse {
  items: FollowedTopic[];
}

const TIER_LABELS: Record<string, { label: string; cls: string; Icon: LucideIcon }> = {
  hot: { label: '热门', cls: 'bg-status-failed-bg text-status-failed-fg', Icon: Flame },
  warming: { label: '升温', cls: 'bg-status-running-bg text-status-running-fg', Icon: TrendingUp },
  emerging: { label: '新出现', cls: 'bg-muted text-muted-foreground', Icon: Sparkles },
};

function formatTimeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function FollowedTopicsStrip() {
  const { data, isLoading } = useQuery<FollowedTopicsResponse>({
    queryKey: ['home', 'followed-topics'],
    queryFn: async () => {
      const r = await fetch('/api/me/topics', { cache: 'no-store' });
      if (!r.ok) throw new Error(`followed topics fetch failed: ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    retry: 1,
  });

  const items = data?.items.slice(0, 5) ?? [];

  return (
    <div className="mt-6">
      <SectionCard
        title="我关注的主题"
        icon={Pin}
        actions={
          <Link href="/topics" className="text-xs text-primary hover:underline">
            全部主题 →
          </Link>
        }
        bodyClassName="p-0"
      >
        {isLoading ? (
          <div className="grid gap-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="还没有关注任何主题"
            description="在主题页点击「关注」即可在此显示。"
            className="border-0 bg-transparent px-0 py-8"
            action={
              <Link href="/topics" className="text-sm text-primary hover:underline">
                浏览主题 →
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map(({ topic }) => {
              const tier = TIER_LABELS[topic.tier] ?? TIER_LABELS.emerging;
              const Icon = tier.Icon;
              return (
                <li key={topic.id}>
                  <Link
                    href={`/topics/${topic.slug}`}
                    className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/30 sm:items-center"
                  >
                    <Badge className={tier.cls}>
                      <Icon className="size-3" />
                      {tier.label}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-sm font-semibold leading-snug tracking-normal hover:text-primary">
                        {topic.name}
                      </h3>
                      {topic.summary ? (
                        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                          {topic.summary}
                        </p>
                      ) : null}
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                        候选 {topic.candidateCount} · 来源 {topic.sourceCount}
                        {topic.lastSyncedAt ? ` · 更新 ${formatTimeAgo(topic.lastSyncedAt)}` : null}
                      </p>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
