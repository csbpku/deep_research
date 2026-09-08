// 顶部未读议题横幅（ADR 0010）。
// 登录用户关注过的专题存在未读议题时显示；否则不渲染。
import Link from 'next/link';
import { Bell, ChevronRight } from 'lucide-react';

import { prisma } from '@/lib/db';
import type { SessionUserOrNull } from '@/lib/auth/session';
import { collapseTopicIssues } from '@/lib/topics';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/**
 * AppShell 顶部"未读议题"提示：
 * 当用户的 TopicFollow 在 14 天内有新出现的 TopicIssue 时，
 * 渲染醒目提示并提供入口。
 */
export async function UnreadIssuesBanner({ user }: { user: SessionUserOrNull }) {
  if (!user) return null;

  const follows = await prisma.topicFollow.findMany({
    where: { userId: user.id },
    select: { topicId: true, lastViewedAt: true },
  });
  if (follows.length === 0) return null;
  const lastViewByTopic = new Map(follows.map((f) => [f.topicId, f.lastViewedAt] as const));
  const issues = await prisma.topicIssue.findMany({
    where: { topicId: { in: follows.map((f) => f.topicId) }, status: 'active' },
    select: {
      topicId: true,
      id: true,
      title: true,
      proposition: true,
      kind: true,
      importanceScore: true,
      lastSeenAt: true,
      candidates: { select: { summaryId: true } },
    },
  });

  let unread = 0;
  const issuesByTopic = new Map<string, typeof issues>();
  for (const issue of issues) {
    const rows = issuesByTopic.get(issue.topicId) ?? [];
    rows.push(issue);
    issuesByTopic.set(issue.topicId, rows);
  }
  for (const [topicId, rows] of issuesByTopic) {
    const publicIssues = collapseTopicIssues(
      rows.map((issue) => ({
        id: issue.id,
        title: issue.title,
        proposition: issue.proposition,
        kind: issue.kind,
        importanceScore: issue.importanceScore,
        lastSeenAt: issue.lastSeenAt,
        candidateIds: (issue.candidates ?? []).map((candidate) => candidate.summaryId),
      })),
    );
    const lastViewedAt = lastViewByTopic.get(topicId) ?? null;
    unread += publicIssues.filter((issue) => (
      !lastViewedAt
      || (typeof issue.lastSeenAt === 'string' ? Date.parse(issue.lastSeenAt) : issue.lastSeenAt.getTime()) > lastViewedAt.getTime()
    )).length;
  }
  if (unread === 0) return null;

  return (
    <Link
      href="/me/topics"
      className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card className="mx-4 my-3 border-primary/40 bg-primary/10 transition-colors hover:bg-primary/15">
        <CardContent className="flex min-w-0 items-center gap-2 p-3 text-sm">
          <Bell className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 truncate font-medium text-primary">我的关注有 {unread} 个新议题未读</span>
          <Badge className="shrink-0 bg-primary/30 text-primary">{unread}</Badge>
          <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden />
        </CardContent>
      </Card>
    </Link>
  );
}
