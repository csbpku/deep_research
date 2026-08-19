// /topics — 技术专题列表 (ADR 0010: 含变化摘要、未读议题、相关研究)
import Link from 'next/link';
import { Sparkles, TrendingUp, Compass, BookOpenCheck, Bell } from 'lucide-react';

import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/domain/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { getCurrentUser } from '@/lib/auth/session';

type IconComponent = React.ComponentType<{ className?: string }>;

const TIER_LABELS: Record<string, { label: string; cls: string; Icon: IconComponent }> = {
  hot: { label: '热门', cls: 'bg-status-failed-bg text-status-failed-fg', Icon: TrendingUp },
  warming: { label: '升温', cls: 'bg-status-running-bg text-status-running-fg', Icon: Sparkles },
  emerging: { label: '新出现', cls: 'bg-muted text-muted-foreground', Icon: Compass },
};

export const dynamic = 'force-dynamic';

export default async function TopicsPage() {
  const user = await getCurrentUser();
  const topics = await prisma.topic.findMany({
    where: { enabled: true },
    orderBy: [{ tier: 'asc' }, { candidateCount: 'desc' }, { updatedAt: 'desc' }],
    take: 80,
    select: {
      id: true,
      slug: true,
      name: true,
      summary: true,
      tier: true,
      candidateCount: true,
      sourceCount: true,
      lastSyncedAt: true,
      aggregationWindowEnd: true,
    },
  });
  if (topics.length === 0) {
    return (
      <div className="mx-auto max-w-shell">
        <PageHeader title="技术专题" description="把分散的雷达信号聚成可持续追踪的研究脉络。" />
        <EmptyState title="暂无专题" description="下一轮雷达同步将自动建组。" />
      </div>
    );
  }
  const topicIds = topics.map((t) => t.id);

  const [follows, issueStats, latestResearch] = await Promise.all([
    user
      ? prisma.topicFollow.findMany({
          where: { userId: user.id, topicId: { in: topicIds } },
          select: { topicId: true, lastViewedAt: true },
        })
      : Promise.resolve([] as Array<{ topicId: string; lastViewedAt: Date | null }>),
    prisma.topicIssue.groupBy({
      by: ['topicId', 'status'],
      where: { topicId: { in: topicIds } },
      _count: { _all: true },
    }),
    prisma.researchTopic.findMany({
      where: { topicId: { in: topicIds } },
      orderBy: { createdAt: 'desc' },
      distinct: ['topicId'],
      select: {
        topicId: true,
        research: { select: { id: true, title: true, status: true } },
      },
      take: topicIds.length * 2,
    }),
  ]);

  const followedMap = new Map(follows.map((f) => [f.topicId, f.lastViewedAt] as const));
  const issueByTopic = new Map<string, { active: number }>();
  for (const row of issueStats) {
    if (row.status !== 'active') continue;
    issueByTopic.set(row.topicId, { active: row._count._all });
  }
  const researchByTopic = new Map<string, { id: string; title: string; status: string }>();
  for (const row of latestResearch) {
    if (!researchByTopic.has(row.topicId)) {
      researchByTopic.set(row.topicId, {
        id: row.research.id,
        title: row.research.title,
        status: row.research.status,
      });
    }
  }

  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title="技术专题"
        description="把分散的雷达信号聚成可持续追踪的研究脉络；先看正在升温的专题，再进入综述、热点议题和团队研究。"
        actions={
          <Link href="/me/topics" className="text-sm text-primary hover:underline">
            {user ? '我的关注' : '查看我的'}
          </Link>
        }
      />
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {topics.map((t) => {
          const tier = TIER_LABELS[t.tier] ?? TIER_LABELS.emerging;
          const TierIcon = tier.Icon;
          const isFollowed = followedMap.has(t.id);
          const lastViewedAt = followedMap.get(t.id) ?? null;
          const issues = issueByTopic.get(t.id)?.active ?? 0;
          const unread = isFollowed && lastViewedAt ? null : issues;
          const research = researchByTopic.get(t.id) ?? null;
          return (
            <li key={t.id}>
              <Link href={`/topics/${t.slug}`} className="block">
                <Card className="h-full transition-colors hover:border-primary/40 hover:shadow-sm">
                  <CardContent className="space-y-2 p-4">
                    <header className="flex flex-wrap items-center gap-1.5">
                      <TierIcon className="size-3.5 text-muted-foreground" />
                      <Badge className={tier.cls}>{tier.label}</Badge>
                      <h2 className="text-sm font-semibold">{t.name}</h2>
                      {isFollowed ? (
                        <Badge className="bg-secondary text-secondary-foreground">
                          已关注
                        </Badge>
                      ) : null}
                      {unread && unread > 0 ? (
                        <Badge className="bg-primary/15 text-primary">
                          <Bell className="mr-1 size-3" />
                          {unread} 个新议题
                        </Badge>
                      ) : null}
                    </header>
                    {t.summary ? (
                      <p className="line-clamp-3 text-xs text-muted-foreground">{t.summary}</p>
                    ) : null}
                    {research ? (
                      <p className="flex items-center gap-1.5 text-[11px] text-primary">
                        <BookOpenCheck className="size-3" />
                        已有团队研究：{research.title.slice(0, 32)}
                      </p>
                    ) : null}
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>{t.candidateCount} 候选 · {t.sourceCount} 来源</span>
                      <span>{t.lastSyncedAt ? new Date(t.lastSyncedAt).toLocaleDateString('zh-CN') : '待同步'}</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
