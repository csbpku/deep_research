// BFF handler: GET /api/me/topics — 当前用户关注的主题。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const items = await prisma.topicFollow.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
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
        },
      },
    },
  });
  return NextResponse.json({
    items: items.map((f) => ({
      followId: f.id,
      followedAt: f.createdAt.toISOString(),
      topic: {
        ...f.topic,
        lastSyncedAt: f.topic.lastSyncedAt?.toISOString() ?? null,
      },
    })),
  });
});
