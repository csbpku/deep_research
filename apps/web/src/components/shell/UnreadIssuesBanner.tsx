// 顶部未读议题横幅（ADR 0010）。
// 登录用户关注过的专题存在未读议题时显示；否则不渲染。
import Link from 'next/link';
import { Bell, ChevronRight } from 'lucide-react';

import { prisma } from '@/lib/db';
import type { SessionUserOrNull } from '@/lib/auth/session';
import { collapseTopicIssues } from '@/lib/topics';
import styles from './shell.module.css';

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
      className={styles.unread}
    >
      <Bell aria-hidden />
      <span className={styles.unreadLabel}>我的关注有 {unread} 个新议题未读</span>
      <span className={styles.unreadCount}>{unread}</span>
      <ChevronRight aria-hidden />
    </Link>
  );
}
