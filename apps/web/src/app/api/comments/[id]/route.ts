// BFF handler: DELETE /api/comments/[id] —— 作者或 admin 删除评论。
//
// 删除策略：
//   - 作者可以删自己的
//   - admin 可以删任何
//   - 子回复不会被删除：schema 的 parent 关系是 onDelete: SetNull，
//     被删评论的直接回复会变成顶层评论（parentId=null）；Research.commentCount 同步为剩余总数

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../lib/db';
import { apiHandler } from '../../../../lib/api-handler';
import { getCurrentUser } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { log, withRequestId } from '../../../../lib/log';
import { CommentIdParam } from '../../../../lib/schemas';
import { newAdminActionRequestId, writeAdminAction } from '../../../../lib/radar/admin-actions';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const DELETE = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await getCurrentUser();
  if (!u) {
    return toApiErrorResponse({
      code: ERROR_CODES.AUTH_NOT_AUTHENTICATED,
      message: '需要登录',
      requestId,
    });
  }

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
    select: {
      id: true,
      authorId: true,
      researchId: true,
      summaryId: true,
      targetType: true,
      parentId: true,
      _count: { select: { children: true, stars: true } },
    },
  });
  if (!comment) {
    return toApiErrorResponse({
      code: ERROR_CODES.NOT_FOUND,
      message: '评论不存在',
      requestId,
    });
  }

  const isAuthor = comment.authorId === u.id;
  const isAdmin = u.role === 'admin';
  if (!isAuthor && !isAdmin) {
    return toApiErrorResponse({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: '只能删除自己的评论',
      requestId,
    });
  }

  const actionRequestId = newAdminActionRequestId();
  await prisma.$transaction(async (tx) => {
    // 删自己：stars 级联删除；子回复因 SetNull 保留并升为顶层评论
    await tx.comment.delete({
      where: { id: comment.id },
      select: { id: true },
    });

    // 同步 research.commentCount
    if (comment.researchId) {
      const remaining = await tx.comment.count({
        where: { researchId: comment.researchId },
      });
      await tx.research.update({
        where: { id: comment.researchId },
        data: { commentCount: remaining },
        select: { id: true },
      });
    }

    // W9 安全复审修订：此前 promote/dismiss 都写 admin_actions 审计，
    // 唯独 DELETE 不写。补齐：仅 admin（非作者）删除时写审计。
    if (isAdmin && !isAuthor) {
      await writeAdminAction(tx, {
        actorId: u.id,
        requestId: actionRequestId,
        action: 'comments.delete',
        targetType: 'comment',
        targetId: comment.id,
        metadata: {
          deletedAuthor: comment.authorId,
          researchId: comment.researchId ?? null,
          summaryId: comment.summaryId ?? null,
          // 回复未被删除，而是 parentId 置空变成顶层评论
          orphanedReplyCount: comment._count.children,
          starCount: comment._count.stars,
        },
      });
    }
  });

  log.info('api.comment.delete', 'comment deleted', {
    requestId,
    userId: u.id,
    commentId: comment.id,
    targetType: comment.targetType,
    orphanedReplies: comment._count.children,
    deletedStars: comment._count.stars,
    actor: isAdmin && !isAuthor ? 'admin' : 'author',
  });

  return NextResponse.json({ ok: true });
});