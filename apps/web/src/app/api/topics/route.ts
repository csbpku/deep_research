// BFF handler: GET /api/topics — 主题列表。
// tier 排序：hot > warming > emerging；同 tier 内按 candidateCount 倒序。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';

export const GET = apiHandler<[NextRequest]>(async () => {
  const user = await getCurrentUser();
  const items = await prisma.topic.findMany({
    orderBy: [{ candidateCount: 'desc' }, { updatedAt: 'desc' }],
    take: 50,
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
      synthesisErrorCode: true,
    },
  });
  let followed: Set<string> = new Set();
  if (user && items.length > 0) {
    const follows = await prisma.topicFollow.findMany({
      where: { userId: user.id, topicId: { in: items.map((i) => i.id) } },
      select: { topicId: true },
    });
    followed = new Set(follows.map((f) => f.topicId));
  }
  return NextResponse.json({
    items: items.map((t) => ({
      ...t,
      lastSyncedAt: t.lastSyncedAt?.toISOString() ?? null,
      synthesisGeneratedAt: t.synthesisGeneratedAt?.toISOString() ?? null,
      followed: followed.has(t.id),
    })),
  });
});
