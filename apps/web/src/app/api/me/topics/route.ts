// BFF handler: GET /api/me/topics — 当前用户关注的专题（ADR 0010 升级）。
//
// 输出：未读议题数 / 最近重要变化 / 最近研究 / 最后查看时间。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { collapseTopicIssues } from '@/lib/topics';

export const dynamic = 'force-dynamic';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const follows = await prisma.topicFollow.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      createdAt: true,
      lastViewedAt: true,
      topic: {
        select: {
          id: true,
          slug: true,
          name: true,
          summary: true,
          tier: true,
          candidateCount: true,
          sourceCount: true,
          lastSyncedAt: true,
          synthesisGeneratedAt: true,
        },
      },
    },
  });
  if (follows.length === 0) {
    return NextResponse.json({ items: [], totalUnread: 0 });
  }

  const topicIds = follows.map((f) => f.topic.id);
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
  const issueByTopic = new Map<string, ReturnType<typeof collapseTopicIssues>>();
  for (const [topicId, rows] of issueRowsByTopic) {
    issueByTopic.set(
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
      research: { select: { id: true, title: true, status: true, type: true } },
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

  const items = follows.map((f) => {
    const list = issueByTopic.get(f.topic.id) ?? [];
    let unread = list.length;
    const last = f.lastViewedAt;
    if (last) {
      unread = list.filter((i) => (
        (typeof i.lastSeenAt === 'string' ? Date.parse(i.lastSeenAt) : i.lastSeenAt.getTime()) > last.getTime()
      )).length;
    }
    const top = list[0];
    const research = researchByTopic.get(f.topic.id) ?? null;
    return {
      followId: f.id,
      followedAt: f.createdAt.toISOString(),
      lastViewedAt: f.lastViewedAt?.toISOString() ?? null,
      topic: {
        ...f.topic,
        lastSyncedAt: f.topic.lastSyncedAt?.toISOString() ?? null,
        synthesisGeneratedAt: f.topic.synthesisGeneratedAt?.toISOString() ?? null,
      },
      activeIssueCount: list.length,
      unreadIssueCount: unread,
      latestIssue: top
        ? { id: top.id, title: top.title, proposition: top.proposition, importanceScore: top.importanceScore }
        : null,
      latestResearch: research,
    };
  });

  const totalUnread = items.reduce((acc, i) => acc + i.unreadIssueCount, 0);

  return NextResponse.json({ items, totalUnread });
});
