// BFF handler: POST /api/admin/comments/[id]/promote —— Admin 从评论提炼成精华（knowledge）。
//
// 流程：
//   1. requireAdmin
//   2. 校验评论存在 + 不是已 approved/rejected
//   3. 创建 Research（type=knowledge, sourceCommentId=commentId, status=published）
//   4. 更新 Comment.promoteStatus='approved'
//   5. 写 admin_actions 审计
//   6. 触发 search_docs 索引（依赖 SearchDoc trigger on Research.publish）

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../../../lib/db';
import { apiHandler, parseBody } from '../../../../../../lib/api-handler';
import { requireAdmin } from '../../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../../lib/errors';
import { log, withRequestId } from '../../../../../../lib/log';
import { AdminCommentPromoteInput, CommentIdParam } from '../../../../../../lib/schemas';
import { newAdminActionRequestId, writeAdminAction } from '../../../../../../lib/radar/admin-actions';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { PROMOTE_STATUS, RESEARCH_STATUS, RESEARCH_TYPE, CREATION_METHOD } from '@deep-research/shared/states';

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

  const body = await parseBody(req, AdminCommentPromoteInput);
  if (body instanceof NextResponse) return body;

  const comment = await prisma.comment.findUnique({
    where: { id: idParsed.data.id },
    select: {
      id: true,
      promoteStatus: true,
      targetType: true,
      summaryId: true,
      researchId: true,
      body: true,
    },
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

  const result = await prisma.$transaction(async (tx) => {
    const research = await tx.research.create({
      data: {
        type: RESEARCH_TYPE.KNOWLEDGE,
        status: RESEARCH_STATUS.PUBLISHED,
        title: body.title,
        body: body.body,
        conclusion: body.conclusion ?? null,
        tags: body.tags,
        authorId: u.id,
        creationMethod: CREATION_METHOD.MANUAL,
        sourceCommentId: comment.id,
        publishedAt: new Date(),
      },
      select: {
        id: true,
        title: true,
        status: true,
        publishedAt: true,
      },
    });

    await tx.comment.update({
      where: { id: comment.id },
      data: { promoteStatus: PROMOTE_STATUS.APPROVED },
      select: { id: true },
    });

    await writeAdminAction(tx, {
      actorId: u.id,
      action: ADMIN_COMMENT_ACTIONS.PROMOTE,
      targetType: ADMIN_TARGET_TYPE,
      targetId: comment.id,
      requestId: actionRequestId,
      metadata: {
        knowledgeResearchId: research.id,
        sourceType: comment.targetType,
        bodyLength: body.body.length,
      },
    });

    return research;
  });

  log.info('admin.comment.promote', 'comment promoted to knowledge', {
    requestId,
    userId: u.id,
    commentId: comment.id,
    researchId: result.id,
    actionRequestId,
  });

  return NextResponse.json({
    ok: true,
    knowledge: {
      id: result.id,
      title: result.title,
      publishedAt: result.publishedAt?.toISOString() ?? null,
    },
    actionRequestId,
  });
});