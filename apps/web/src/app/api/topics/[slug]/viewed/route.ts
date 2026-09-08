// BFF handler: POST /api/topics/[slug]/viewed — 标记专题为已查看。
//
// ADR 0010：用户在热点议题视图中显式标记已读后，前端调用此接口；
// 推进 TopicFollow.lastViewedAt 用于未读议题计数。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { recordProductEvent } from '@/lib/product-events';
import { findTopicBySlugOrId } from '@/lib/topics';

export const dynamic = 'force-dynamic';

export const POST = apiHandler<[NextRequest, { params: Promise<{ slug: string }> }]>(async (req, ctx) => {
  const { slug } = await ctx.params;
  if (!slug) {
    return NextResponse.json({ code: 'NOT_FOUND', message: 'topic 不存在' }, { status: 404 });
  }
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const topic = await findTopicBySlugOrId(slug, { id: true, slug: true });
  if (!topic) {
    return NextResponse.json({ code: 'NOT_FOUND', message: 'topic 不存在' }, { status: 404 });
  }

  const follow = await prisma.topicFollow.upsert({
    where: { userId_topicId: { userId: u.id, topicId: topic.id } },
    create: { userId: u.id, topicId: topic.id, lastViewedAt: new Date() },
    update: { lastViewedAt: new Date() },
    select: { id: true, lastViewedAt: true },
  });

  await recordProductEvent({
    userId: u.id,
    eventType: 'topic_viewed_with_unread',
    targetType: 'topic',
    targetId: topic.id,
    metadata: { slug: topic.slug },
  }).catch(() => undefined);

  return NextResponse.json({
    ok: true,
    lastViewedAt: follow.lastViewedAt?.toISOString() ?? null,
  });
});
