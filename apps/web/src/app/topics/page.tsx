// /topics — 热点主题列表 (P1-D)
import Link from 'next/link';
import { Sparkles, TrendingUp, Flame, Pin } from 'lucide-react';

import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/domain/PageHeader';
import { SectionCard } from '@/components/domain/SectionCard';
import { StatCard } from '@/components/domain/StatCard';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { getCurrentUser } from '@/lib/auth/session';

const TIER_LABELS: Record<string, { label: string; cls: string; Icon: typeof Flame }> = {
  hot: { label: '热门', cls: 'bg-status-failed-bg text-status-failed-fg', Icon: Flame },
  warming: { label: '升温', cls: 'bg-status-running-bg text-status-running-fg', Icon: TrendingUp },
  emerging: { label: '新出现', cls: 'bg-muted text-muted-foreground', Icon: Sparkles },
};

export default async function TopicsPage() {
  const user = await getCurrentUser();
  const topics = await prisma.topic.findMany({
    orderBy: [{ candidateCount: 'desc' }, { updatedAt: 'desc' }],
    take: 50,
  });
  const followedSet = user
    ? new Set(
        (await prisma.topicFollow.findMany({
          where: { userId: user.id, topicId: { in: topics.map((t) => t.id) } },
          select: { topicId: true },
        })).map((f) => f.topicId),
      )
    : new Set<string>();

  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title="热点主题"
        description="把分散的雷达信号聚成可持续追踪的研究脉络；先看正在升温的主题，再进入综述和证据。"
        actions={
          <div className="flex items-center gap-3">
            {user ? (
              <Link href="/me/topics" className="text-sm text-primary hover:underline">
                我的关注 →
              </Link>
            ) : null}
          </div>
        }
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="活跃主题" value={topics.length} hint="最近 14 天有新信号" tone="primary" />
        <StatCard label="热门 / 升温" value={topics.filter((t) => t.tier === 'hot' || t.tier === 'warming').length} hint="值得本周跟进" />
        <StatCard label="我的关注" value={followedSet.size} hint="会出现在关注列表" tone="muted" />
      </div>
      {topics.length === 0 ? (
        <EmptyState
          title="暂无成立的热点主题"
          description="只有指向同一具体议题、且 14 天内有 ≥ 3 条信号和至少 2 个独立来源时才会展示；AI、LLM 和编程语言等宽泛分类不会作为主题。"
        />
      ) : (
        <SectionCard
          title="主题脉络"
          actions={<span className="text-xs text-muted-foreground">按信号数量排序 · {topics.length} 个</span>}
          bodyClassName="p-0"
        >
          <ul className="divide-y divide-border">
          {topics.map((t, index) => {
            const tier = TIER_LABELS[t.tier] ?? TIER_LABELS.emerging;
            const Icon = tier.Icon;
            return (
              <li key={t.id}>
                <div className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-muted/30 sm:items-center">
                  <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-xs text-muted-foreground sm:pt-0">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge className={tier.cls}>
                          <Icon className="size-3" />
                          {tier.label}
                        </Badge>
                        {followedSet.has(t.id) ? (
                          <Badge variant="secondary">
                            <Pin className="size-3" />
                            已关注
                          </Badge>
                        ) : null}
                        <h2 className="ml-1 text-sm font-semibold">
                          <Link href={`/topics/${t.slug}`} className="hover:text-primary hover:underline">
                            {t.name}
                          </Link>
                        </h2>
                      </div>
                      {t.summary ? (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{t.summary}</p>
                      ) : null}
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      候选 {t.candidateCount} · 来源 {t.sourceCount}
                      {t.synthesisGeneratedAt ? ' · 综述已生成' : t.synthesisErrorCode ? ' · 综述失败' : ' · 待生成综述'}
                    </p>
                  </div>
                  <Link href={`/topics/${t.slug}`} className="hidden shrink-0 text-xs font-medium text-primary hover:underline sm:inline-flex">
                    查看主题 →
                  </Link>
                </div>
              </li>
            );
          })}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
