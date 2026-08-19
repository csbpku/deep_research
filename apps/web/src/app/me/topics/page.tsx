// /me/topics — 当前用户关注的技术专题（ADR 0010 升级：未读议题 + 最近变化）。
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, BookOpenCheck, Compass, Pin, Sparkles, TrendingUp } from 'lucide-react';

import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { PageHeader } from '@/components/domain/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';

type IconComponent = React.ComponentType<{ className?: string }>;
const TIER_LABELS: Record<string, { label: string; cls: string; Icon: IconComponent }> = {
  hot: { label: '热门', cls: 'bg-status-failed-bg text-status-failed-fg', Icon: TrendingUp },
  warming: { label: '升温', cls: 'bg-status-running-bg text-status-running-fg', Icon: Sparkles },
  emerging: { label: '新出现', cls: 'bg-muted text-muted-foreground', Icon: Compass },
};

export const dynamic = 'force-dynamic';

export default async function MyTopicsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/signin?callbackUrl=/me/topics');

  const follows = await prisma.topicFollow.findMany({
    where: { userId: user.id },
    orderBy: [{ lastViewedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    include: { topic: true },
  });
  if (follows.length === 0) {
    return (
      <div className="mx-auto max-w-shell">
        <Link href="/me" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3" />
          返回我的
        </Link>
        <PageHeader title="我的技术专题" description="长期关注的技术对象；新出现的热点议题会出现在这里。" />
        <EmptyState
          title="还没有关注"
          description="到 /topics 浏览后点击关注；专题内的热点议题会自动聚合并按未读顺序展示。"
          action={
            <Link href="/topics" className="text-sm text-primary hover:underline">
              去专题列表 →
            </Link>
          }
        />
      </div>
    );
  }

  const topicIds = follows.map((f) => f.topicId);
  const issues = await prisma.topicIssue.findMany({
    where: { topicId: { in: topicIds }, status: 'active' },
    orderBy: { lastSeenAt: 'desc' },
    select: {
      id: true,
      topicId: true,
      title: true,
      proposition: true,
      importanceScore: true,
      lastSeenAt: true,
    },
  });
  const issuesByTopic = new Map<string, typeof issues>();
  for (const issue of issues) {
    const arr = issuesByTopic.get(issue.topicId) ?? [];
    arr.push(issue);
    issuesByTopic.set(issue.topicId, arr);
  }

  const latestResearch = await prisma.researchTopic.findMany({
    where: { topicId: { in: topicIds } },
    orderBy: { createdAt: 'desc' },
    distinct: ['topicId'],
    select: {
      topicId: true,
      createdAt: true,
      research: { select: { id: true, title: true, status: true } },
    },
    take: topicIds.length * 2,
  });
  const researchByTopic = new Map<string, { id: string; title: string; status: string; at: string }>();
  for (const row of latestResearch) {
    if (!researchByTopic.has(row.topicId)) {
      researchByTopic.set(row.topicId, {
        id: row.research.id,
        title: row.research.title,
        status: row.research.status,
        at: row.createdAt.toISOString(),
      });
    }
  }

  let totalUnread = 0;

  return (
    <div className="mx-auto max-w-shell">
      <Link href="/me" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3" />
        返回我的
      </Link>
      <PageHeader
        title="我的技术专题"
        description="关注长期跟踪的技术对象；出现新的热点议题会自动显示在这里，按未读顺序排列。"
      />
      <ul className="grid list-none gap-3 p-0">
        {follows.map((f) => {
          const t = f.topic;
          const tier = TIER_LABELS[t.tier] ?? TIER_LABELS.emerging;
          const list = issuesByTopic.get(t.id) ?? [];
          let unread = list.length;
          const last = f.lastViewedAt;
          if (last) {
            unread = list.filter((i) => i.lastSeenAt.getTime() > last.getTime()).length;
          }
          const top = list[0];
          const latest = researchByTopic.get(t.id) ?? null;
          totalUnread += unread;
          const TierIcon = tier.Icon;
          return (
            <li key={f.id}>
              <Card>
                <CardContent className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TierIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <Badge className={tier.cls}>{tier.label}</Badge>
                    <h2 className="text-sm font-semibold">
                      <Link href={`/topics/${t.slug}`} className="hover:text-primary hover:underline">
                        {t.name}
                      </Link>
                    </h2>
                    {unread > 0 ? (
                      <Badge className="bg-primary/15 text-primary">
                        {unread} 个未读议题
                      </Badge>
                    ) : null}
                    {latest ? (
                      <Badge className="bg-secondary text-secondary-foreground">
                        已有团队研究
                      </Badge>
                    ) : null}
                  </div>
                  {top ? (
                    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <BookOpenCheck className="size-3.5 text-primary" />
                        {top.title}
                      </div>
                      <p className="mt-1 line-clamp-2 text-muted-foreground">{top.proposition}</p>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                    <span>候选 {t.candidateCount}</span>
                    <span>·</span>
                    <span>上次查看 {f.lastViewedAt ? new Date(f.lastViewedAt).toLocaleString('zh-CN') : '从未'}</span>
                    {latest ? (
                      <>
                        <span>·</span>
                        <Link href={`/research/${latest.id}`} className="text-primary hover:underline">
                          最近研究：{latest.title.slice(0, 30)}
                        </Link>
                      </>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-xs text-muted-foreground">
        共 {follows.length} 个专题，{totalUnread} 个未读议题
      </p>
    </div>
  );
}
