// BFF handler: POST/DELETE /api/comments/[id]/star —— 评论点赞（一人一票）。
//
// 契约源：schema.prisma::CommentStar (@@unique [commentId, userId])
// Week 8：基础点赞（不是 Phase 1a 的 3 票自动提名）；后者需要 trigger，本周只搭架子。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../../lib/db';
import { apiHandler } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { log, withRequestId } from '../../../../../lib/log';
import { CommentIdParam } from '../../../../../lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const idParsed = CommentIdParam.safeParse(await ctx.params);
  if (!idParsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: idParsed.error.flatten(),
    });
  }

  const comment = await prisma.comment.findUnique({
    where: { id: idParsed.data.id },
    select: { id: true },
  });
  if (!comment) {
    return toApiErrorResponse({
      code: ERROR_CODES.NOT_FOUND,
      message: '评论不存在',
      requestId,
    });
  }

  // @@unique([commentId, userId]) 自然幂等；duplicate 后 P2002 直接返回当前计数
  try {
    await prisma.$transaction(async (tx) => {
      await tx.commentStar.create({
        data: { commentId: idParsed.data.id, userId: u.id },
        select: { id: true },
      });
      await tx.comment.update({
        where: { id: idParsed.data.id },
        data: { starCount: { increment: 1 } },
        select: { id: true },
      });
    });
  } catch (err) {
    // 重复点赞：P2002；返回当前计数（幂等成功）
    const code = (err as { code?: string }).code;
    if (code !== 'P2002') throw err;
  }

  const after = await prisma.comment.findUnique({
    where: { id: idParsed.data.id },
    select: { starCount: true },
  });

  log.info('api.comment.star', 'comment starred', {
    requestId,
    userId: u.id,
    commentId: idParsed.data.id,
    starCount: after?.starCount ?? 0,
  });

  return NextResponse.json({ ok: true, starCount: after?.starCount ?? 0 });
});

export const DELETE = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const idParsed = CommentIdParam.safeParse(await ctx.params);
  if (!idParsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: idParsed.error.flatten(),
    });
  }

  const existing = await prisma.commentStar.findUnique({
    where: { commentId_userId: { commentId: idParsed.data.id, userId: u.id } },
    select: { id: true },
  });
  if (!existing) {
    // 已经没点赞了；返回当前计数（幂等成功）
    const cur = await prisma.comment.findUnique({
      where: { id: idParsed.data.id },
      select: { starCount: true },
    });
    return NextResponse.json({ ok: true, starCount: cur?.starCount ?? 0 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.commentStar.delete({
      where: { commentId_userId: { commentId: idParsed.data.id, userId: u.id } },
      select: { id: true },
    });
    await tx.comment.update({
      where: { id: idParsed.data.id },
      data: { starCount: { decrement: 1 } },
      select: { id: true },
    });
  });

  const after = await prisma.comment.findUnique({
    where: { id: idParsed.data.id },
    select: { starCount: true },
  });

  log.info('api.comment.unstar', 'comment unstarred', {
    requestId,
    userId: u.id,
    commentId: idParsed.data.id,
    starCount: after?.starCount ?? 0,
  });

  return NextResponse.json({ ok: true, starCount: Math.max(0, after?.starCount ?? 0) });
});