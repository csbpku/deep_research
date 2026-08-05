// BFF handler: POST /api/topics/[slug]/follow + DELETE — 关注 / 取消关注主题 (P1-D)。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';

async function resolveTopicId(slug: string): Promise<string | NextResponse> {
  const topic = await prisma.topic.findUnique({ where: { slug }, select: { id: true } });
  if (!topic) {
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: 'topic 不存在', requestId: '' });
  }
  return topic.id;
}

export const POST = apiHandler<[NextRequest, { params: Promise<{ slug: string }> }]>(async (req, ctx) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const requestId = withRequestId(req.headers);
  const { slug } = await ctx.params;
  const topicId = await resolveTopicId(slug);
  if (topicId instanceof NextResponse) {
    if (!requestId) return topicId;
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: 'topic 不存在', requestId });
  }
  const created = await prisma.topicFollow.upsert({
    where: { userId_topicId: { userId: user.id, topicId } },
    update: {},
    create: { userId: user.id, topicId },
    select: { id: true, createdAt: true },
  });
  return NextResponse.json({ ok: true, id: created.id, followed: true, requestId }, { status: 201 });
});

export const DELETE = apiHandler<[NextRequest, { params: Promise<{ slug: string }> }]>(async (req, ctx) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const requestId = withRequestId(req.headers);
  const { slug } = await ctx.params;
  const topicId = await resolveTopicId(slug);
  if (topicId instanceof NextResponse) {
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: 'topic 不存在', requestId });
  }
  const r = await prisma.topicFollow.deleteMany({ where: { userId: user.id, topicId } });
  return NextResponse.json({ ok: true, deleted: r.count, followed: false, requestId });
});
