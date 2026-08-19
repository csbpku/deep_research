// BFF handler: GET /api/topics — 专题列表（ADR 0010 增强）。
//
// tier + change 排序；支持全部/热门/升温/新出现/我的关注；
// 输出含当前热度、未读议题数、最近重要变化、最近研究等。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { recordProductEvent } from '@/lib/product-events';

type Filter = 'all' | 'hot' | 'warming' | 'emerging' | 'followed';

function parseFilter(value: string | null): Filter {
  switch (value) {
    case 'hot':
    case 'warming':
    case 'emerging':
    case 'followed':
      return value;
    default:
      return 'all';
  }
}

export const dynamic = 'force-dynamic';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const url = new URL(req.url);
  const filter = parseFilter(url.searchParams.get('filter'));
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 80) : 30;

  const user = await getCurrentUser();
  const followedFilter = filter === 'followed' && user
    ? {
        followers: { some: { userId: user.id } },
      }
    : {};

  const tierFilter = filter === 'hot' || filter === 'warming' || filter === 'emerging'
    ? { tier: filter }
    : {};

  const items = await prisma.topic.findMany({
    where: {
      enabled: true,
      ...followedFilter,
      ...tierFilter,
    },
    orderBy: [{ tier: 'asc' }, { candidateCount: 'desc' }, { updatedAt: 'desc' }],
    take: limit,
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
      lastSynthesisSuccessAt: true,
      synthesisErrorCode: true,
      aggregationWindowEnd: true,
    },
  });

  if (items.length === 0) {
    return NextResponse.json({ items: [], total: 0, filter });
  }

  const topicIds = items.map((i) => i.id);

  const [follows, issueRows, latestResearch] = await Promise.all([
    user
      ? prisma.topicFollow.findMany({
          where: { userId: user.id, topicId: { in: topicIds } },
          select: { topicId: true, lastViewedAt: true },
        })
      : Promise.resolve([] as Array<{ topicId: string; lastViewedAt: Date | null }>),
    prisma.topicIssue.findMany({
      where: { topicId: { in: topicIds }, status: 'active' },
      select: { topicId: true, lastSeenAt: true },
    }),
    prisma.researchTopic.findMany({
      where: { topicId: { in: topicIds } },
      orderBy: { createdAt: 'desc' },
      distinct: ['topicId'],
      select: {
        topicId: true,
        createdAt: true,
        research: { select: { id: true, title: true, status: true } },
      },
      take: topicIds.length * 3,
    }),
  ]);

  const followedMap = new Map(follows.map((f) => [f.topicId, f.lastViewedAt] as const));
  const activeIssueDatesByTopic = new Map<string, Date[]>();
  const activeIssueCountByTopic = new Map<string, number>();
  for (const row of issueRows) {
    const list = activeIssueDatesByTopic.get(row.topicId) ?? [];
    list.push(row.lastSeenAt);
    activeIssueDatesByTopic.set(row.topicId, list);
    activeIssueCountByTopic.set(row.topicId, (activeIssueCountByTopic.get(row.topicId) ?? 0) + 1);
  }
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

  const totalCount = await prisma.topic.count({
    where: {
      enabled: true,
      ...followedFilter,
      ...tierFilter,
    },
  });

  return NextResponse.json({
    items: items.map((t) => {
      const lastViewedAt = followedMap.get(t.id) ?? null;
      const activeDates = activeIssueDatesByTopic.get(t.id) ?? [];
      const latest = researchByTopic.get(t.id) ?? null;
      const isFollowed = followedMap.has(t.id);
      // 未读 = 当前 active 且 lastSeenAt 晚于 lastViewedAt。
      // 未关注或首次查看时，全部 active 都视为未读。
      const unreadCount = isFollowed
        ? lastViewedAt
          ? activeDates.filter((d) => d.getTime() > lastViewedAt.getTime()).length
          : activeDates.length
        : 0;
      return {
        ...t,
        lastSyncedAt: t.lastSyncedAt?.toISOString() ?? null,
        synthesisGeneratedAt: t.synthesisGeneratedAt?.toISOString() ?? null,
        lastSynthesisSuccessAt: t.lastSynthesisSuccessAt?.toISOString() ?? null,
        aggregationWindowEnd: t.aggregationWindowEnd.toISOString(),
        followed: isFollowed,
        lastViewedAt: lastViewedAt?.toISOString() ?? null,
        activeIssueCount: activeDates.length,
        unreadIssueCount: unreadCount,
        latestResearch: latest,
      };
    }),
    total: totalCount,
    filter,
  });
});
