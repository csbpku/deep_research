// 顶部未读议题横幅（ADR 0010）。
// 登录用户关注过的专题存在未读议题时显示；否则不渲染。
import Link from 'next/link';
import { Bell } from 'lucide-react';

import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/**
 * AppShell 顶部"未读议题"提示：
 * 当用户的 TopicFollow 在 14 天内有新出现的 TopicIssue 时，
 * 渲染醒目提示并提供入口。
 */
export async function UnreadIssuesBanner() {
  const user = await getCurrentUser();
  if (!user) return null;

  const follows = await prisma.topicFollow.findMany({
    where: { userId: user.id },
    select: { topicId: true, lastViewedAt: true },
  });
  if (follows.length === 0) return null;
  const lastViewByTopic = new Map(follows.map((f) => [f.topicId, f.lastViewedAt] as const));
  const issues = await prisma.topicIssue.findMany({
    where: { topicId: { in: follows.map((f) => f.topicId) }, status: 'active' },
    select: { topicId: true, lastSeenAt: true },
  });

  let unread = 0;
  for (const issue of issues) {
    const lastViewedAt = lastViewByTopic.get(issue.topicId) ?? null;
    if (!lastViewedAt || issue.lastSeenAt.getTime() > lastViewedAt.getTime()) {
      unread += 1;
    }
  }
  if (unread === 0) return null;

  return (
    <Link href="/me/topics" className="block focus-visible:outline-none">
      <Card className="m-4 border-primary/40 bg-primary/10 transition-colors hover:bg-primary/15">
        <CardContent className="flex flex-wrap items-center gap-2 p-3 text-sm">
          <Bell className="size-4 text-primary" />
          <span className="font-medium text-primary">我的关注有 {unread} 个新议题未读</span>
          <Badge className="bg-primary/30 text-primary">{unread}</Badge>
          <span className="ml-auto text-xs text-muted-foreground">点此进入我的专题</span>
        </CardContent>
      </Card>
    </Link>
  );
}
