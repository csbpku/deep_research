// /me/topics — 当前用户关注的技术专题（ADR 0010 升级：未读议题 + 最近变化）。
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, BookOpenCheck, Compass, Sparkles, TrendingUp } from 'lucide-react';

import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { collapseTopicIssues } from '@/lib/topics';
import { PageHeader } from '@/components/domain/PageHeader';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';

type IconComponent = React.ComponentType<{ className?: string }>;
/** Tier icon 与颜色 —— 颜色由 StatusBadge kind="topicTier" 统一管理 */
const TIER_ICONS: Record<string, IconComponent> = {
  hot: TrendingUp,
  warming: Sparkles,
  emerging: Compass,
};

/** 相对时间格式：避免全 `toLocaleString` 在数据密集页视觉拥挤 */
function formatRelative(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const diff = Date.now() - d.getTime();
  const minute = 60_000, hour = 3_600_000, day = 86_400_000;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return d.toLocaleDateString('zh-CN');
}

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
        <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
          <Link href="/me">
            <ArrowLeft className="size-3.5" />
            返回我的
          </Link>
        </Button>
        <PageHeader
          title="我的技术专题"
          description="长期关注的技术对象（专题 = 把同一类技术话题聚合到一起的卡片，例如「LLM 评估」「RAG 架构」）；新出现的热点议题会出现在这里。"
        />
        <EmptyState
          title="还没有关注"
          description="到「专题列表」浏览并点击任一专题的关注按钮；专题内的热点议题会自动聚合并按未读顺序展示。"
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
      kind: true,
      importanceScore: true,
      lastSeenAt: true,
      candidates: { select: { summaryId: true } },
    },
  });
  const issueRowsByTopic = new Map<string, typeof issues>();
  for (const issue of issues) {
    const rows = issueRowsByTopic.get(issue.topicId) ?? [];
    rows.push(issue);
    issueRowsByTopic.set(issue.topicId, rows);
  }
  const issuesByTopic = new Map<string, ReturnType<typeof collapseTopicIssues>>();
  for (const [topicId, rows] of issueRowsByTopic) {
    issuesByTopic.set(
      topicId,
      collapseTopicIssues(
        rows.map((issue) => ({
          id: issue.id,
          title: issue.title,
          proposition: issue.proposition,
          kind: issue.kind,
          importanceScore: issue.importanceScore,
          lastSeenAt: issue.lastSeenAt,
          candidateIds: (issue.candidates ?? []).map((candidate) => candidate.summaryId),
        })),
      ),
    );
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
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link href="/me">
          <ArrowLeft className="size-3.5" />
          返回我的
        </Link>
      </Button>
      <PageHeader
        title="我的技术专题"
        description="关注长期跟踪的技术对象；出现新的热点议题会自动显示在这里，按未读顺序排列。"
      />
      <ul className="grid list-none gap-3 p-0">
        {follows.map((f) => {
          const t = f.topic;
          const TierIcon = TIER_ICONS[t.tier] ?? Compass;
          const list = issuesByTopic.get(t.id) ?? [];
          let unread = list.length;
          const last = f.lastViewedAt;
          if (last) {
            unread = list.filter((i) => (
              (typeof i.lastSeenAt === 'string' ? Date.parse(i.lastSeenAt) : i.lastSeenAt.getTime()) > last.getTime()
            )).length;
          }
          const top = list[0];
          const latest = researchByTopic.get(t.id) ?? null;
          totalUnread += unread;
          return (
            <li key={f.id}>
              <Card>
                <CardContent className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TierIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <StatusBadge kind="topicTier" value={t.tier} />
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
                    <span>{t.candidateCount} 条相关内容</span>
                    <span>·</span>
                    <span>{list.length} 个活跃议题</span>
                    <span>·</span>
                    <span>上次查看 {f.lastViewedAt ? formatRelative(f.lastViewedAt) : '从未'}</span>
                    {latest ? (
                      <>
                        <span>·</span>
                        <Link href={`/research/${latest.id}`} className="text-primary hover:underline">
                          最近研究：<span className="line-clamp-1 inline-block max-w-[20ch] align-middle">{latest.title}</span>
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
