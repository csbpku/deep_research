// BFF handler: POST /api/admin/comments/[id]/dismiss —— Admin 拒绝评论提名。
//
// 校验：评论存在 + promoteStatus != approved/rejected
// 操作：Comment.promoteStatus='rejected' + 写 admin_actions

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../../../lib/db';
import { apiHandler, parseBody } from '../../../../../../lib/api-handler';
import { requireAdmin } from '../../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../../lib/errors';
import { log, withRequestId } from '../../../../../../lib/log';
import { AdminCommentDismissInput, CommentIdParam } from '../../../../../../lib/schemas';
import { newAdminActionRequestId, writeAdminAction } from '../../../../../../lib/radar/admin-actions';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { PROMOTE_STATUS } from '@deep-research/shared/states';

const ADMIN_TARGET_TYPE = 'comment' as const;
const ADMIN_COMMENT_ACTIONS = {
  PROMOTE: 'comment_promote',
  DISMISS: 'comment_dismiss',
} as const;

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireAdmin(req);
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

  const body = await parseBody(req, AdminCommentDismissInput);
  if (body instanceof NextResponse) return body;

  const comment = await prisma.comment.findUnique({
    where: { id: idParsed.data.id },
    select: { id: true, promoteStatus: true },
  });
  if (!comment) {
    return toApiErrorResponse({
      code: ERROR_CODES.NOT_FOUND,
      message: '评论不存在',
      requestId,
    });
  }
  if (comment.promoteStatus === PROMOTE_STATUS.APPROVED || comment.promoteStatus === PROMOTE_STATUS.REJECTED) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '该评论已被处理',
      requestId,
    });
  }

  const actionRequestId = newAdminActionRequestId();

  await prisma.$transaction(async (tx) => {
    await tx.comment.update({
      where: { id: comment.id },
      data: { promoteStatus: PROMOTE_STATUS.REJECTED },
      select: { id: true },
    });
    await writeAdminAction(tx, {
      actorId: u.id,
      action: ADMIN_COMMENT_ACTIONS.DISMISS,
      targetType: ADMIN_TARGET_TYPE,
      targetId: comment.id,
      requestId: actionRequestId,
      metadata: { reason: body.reason },
    });
  });

  log.info('admin.comment.dismiss', 'comment nomination dismissed', {
    requestId,
    userId: u.id,
    commentId: comment.id,
    actionRequestId,
  });

  return NextResponse.json({ ok: true, actionRequestId });
});