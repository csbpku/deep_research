// /topics — 热点主题列表 (P1-D)
import Link from 'next/link';
import { Sparkles, TrendingUp, Flame, Pin } from 'lucide-react';

import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/domain/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { getCurrentUser } from '@/lib/auth/session';
import { AdminTopicActions } from '@/components/topics/AdminTopicActions';

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
        description="基于最近 14 天雷达候选自动归并；按 热门 / 升温 / 新出现 分级。"
        actions={
          <div className="flex items-center gap-3">
            {user ? (
              <Link href="/me/topics" className="text-sm text-primary hover:underline">
                我的关注 →
              </Link>
            ) : null}
            {user?.role === 'admin' ? <AdminTopicActions /> : null}
          </div>
        }
      />
      {topics.length === 0 ? (
        <EmptyState
          title="暂无主题"
          description="候选积累到 14 天 ≥ 3 条 + 至少 2 个独立来源后会自动聚合成主题。"
        />
      ) : (
        <ul className="grid list-none gap-2 p-0">
          {topics.map((t) => {
            const tier = TIER_LABELS[t.tier] ?? TIER_LABELS.emerging;
            const Icon = tier.Icon;
            return (
              <li key={t.id}>
                <Card>
                  <CardContent className="flex items-center gap-3 p-4">
                    <div className="flex-1 min-w-0">
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
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
