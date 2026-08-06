import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { recipientId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        type: true,
        readAt: true,
        createdAt: true,
        actor: { select: { id: true, name: true, avatarUrl: true } },
        sourceComment: {
          select: {
            body: true,
            researchId: true,
            summaryId: true,
            summary: { select: { canonicalUrl: true } },
          },
        },
      },
    }),
    prisma.notification.count({ where: { recipientId: user.id, readAt: null } }),
  ]);

  return NextResponse.json({
    unreadCount,
    items: items.map((item) => ({
      id: item.id,
      type: item.type,
      readAt: item.readAt?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
      actor: item.actor,
      excerpt: item.sourceComment.body.slice(0, 180),
      href: item.sourceComment.researchId
        ? `/researches/${item.sourceComment.researchId}#discussion`
        : item.sourceComment.summaryId
          ? `${item.sourceComment.summary?.canonicalUrl.startsWith('digest://') ? '/summaries' : '/radar'}/${item.sourceComment.summaryId}#discussion`
          : '/me?tab=notifications',
    })),
  });
});

export const PATCH = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const result = await prisma.notification.updateMany({
    where: { recipientId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true, updated: result.count });
});
