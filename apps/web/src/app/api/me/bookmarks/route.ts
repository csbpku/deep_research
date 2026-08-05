// BFF handler: GET/POST/DELETE /api/me/bookmarks — 当前用户收藏。
//
// DELETE 通过 query ?id= 删单条；POST body 为 { targetType, targetId, note? }。
// 同一 (user, targetType, targetId) 重复 POST → 返回已存在的 id（不报错）。
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { hydrateBookmarks } from '@/lib/me/bookmarks';
import { ERROR_CODES } from '@deep-research/shared/errors';

const postSchema = z.object({
  targetType: z.enum(['radar_candidate', 'summary', 'research', 'knowledge', 'daily_digest']),
  targetId: z.string().uuid(),
  note: z.string().max(500).optional(),
});

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const requestId = withRequestId(req.headers);
  const items = await prisma.userBookmark.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return NextResponse.json({
    items: await hydrateBookmarks(items),
    requestId,
  });
});

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const requestId = withRequestId(req.headers);

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await req.json());
  } catch (err) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: err instanceof Error ? err.message : '请求体非法',
      requestId,
    });
  }

  if (body.targetType === 'radar_candidate') {
    const radar = await prisma.summary.findUnique({
      where: { id: body.targetId },
      select: { source: true, syncRunId: true },
    });
    if (!radar || radar.source !== 'daily' || radar.syncRunId === null) {
      return toApiErrorResponse({
        code: ERROR_CODES.DRAFT_NOT_FOUND,
        message: '雷达候选不存在',
        requestId,
      });
    }
  }

  const existing = await prisma.userBookmark.findUnique({
    where: {
      userId_targetType_targetId: {
        userId: user.id,
        targetType: body.targetType,
        targetId: body.targetId,
      },
    },
  });
  if (existing) {
    if (body.targetType === 'radar_candidate') {
      await prisma.radarFeedback.upsert({
        where: {
          summaryId_userId_feedbackType: {
            summaryId: body.targetId,
            userId: user.id,
            feedbackType: 'favorite',
          },
        },
        create: { summaryId: body.targetId, userId: user.id, feedbackType: 'favorite' },
        update: {},
      });
    }
    return NextResponse.json(
      { ok: true, id: existing.id, dedup: true, requestId },
      { status: 200 },
    );
  }
  const created = body.targetType === 'radar_candidate'
    ? await prisma.$transaction(async (tx) => {
        const bookmark = await tx.userBookmark.create({
          data: {
            userId: user.id,
            targetType: body.targetType,
            targetId: body.targetId,
            note: body.note,
          },
          select: { id: true, createdAt: true },
        });
        await tx.radarFeedback.upsert({
          where: {
            summaryId_userId_feedbackType: {
              summaryId: body.targetId,
              userId: user.id,
              feedbackType: 'favorite',
            },
          },
          create: { summaryId: body.targetId, userId: user.id, feedbackType: 'favorite' },
          update: {},
        });
        return bookmark;
      })
    : await prisma.userBookmark.create({
        data: {
          userId: user.id,
          targetType: body.targetType,
          targetId: body.targetId,
          note: body.note,
        },
        select: { id: true, createdAt: true },
      });
  return NextResponse.json(
    { ok: true, id: created.id, createdAt: created.createdAt.toISOString(), requestId },
    { status: 201 },
  );
});

export const DELETE = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const requestId = withRequestId(req.headers);
  const id = new URL(req.url).searchParams.get('id');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: 'id 必须为 UUID', requestId });
  }
  const bookmark = await prisma.userBookmark.findFirst({
    where: { id, userId: user.id },
    select: { targetType: true, targetId: true },
  });
  const result = bookmark?.targetType === 'radar_candidate'
    ? await prisma.$transaction(async (tx) => {
        const removed = await tx.userBookmark.deleteMany({ where: { id, userId: user.id } });
        await tx.radarFeedback.deleteMany({
          where: {
            summaryId: bookmark.targetId,
            userId: user.id,
            feedbackType: 'favorite',
          },
        });
        return removed;
      })
    : await prisma.userBookmark.deleteMany({ where: { id, userId: user.id } });
  return NextResponse.json({ ok: true, deleted: result.count, requestId });
});
