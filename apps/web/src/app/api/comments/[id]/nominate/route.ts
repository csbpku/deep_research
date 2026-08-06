// BFF handler: POST /api/comments/[id]/nominate —— 团队成员提议将评论沉淀为知识。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../../lib/db';
import { apiHandler } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { log, withRequestId } from '../../../../../lib/log';
import { CommentIdParam } from '../../../../../lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { PROMOTE_STATUS } from '@deep-research/shared/states';

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const parsed = CommentIdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const comment = await prisma.comment.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      parentId: true,
      promoteStatus: true,
      summary: {
        select: {
          status: true,
          source: true,
          syncRunId: true,
          shareSource: { select: { status: true } },
        },
      },
      research: { select: { status: true } },
    },
  });
  if (!comment) {
    return toApiErrorResponse({
      code: ERROR_CODES.NOT_FOUND,
      message: '评论不存在',
      requestId,
    });
  }
  if (comment.parentId) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '请提议沉淀主评论，回复会随讨论上下文保留',
      requestId,
    });
  }
  const visibleSummary = comment.summary && (
    comment.summary.status === 'published'
    || (comment.summary.source === 'daily' && comment.summary.syncRunId !== null)
    || (comment.summary.source === 'user' && comment.summary.shareSource?.status === 'approved')
  );
  const visibleResearch = comment.research?.status === 'published';
  if (!visibleSummary && !visibleResearch) {
    return toApiErrorResponse({
      code: ERROR_CODES.NOT_FOUND,
      message: '评论不存在或不可提议沉淀',
      requestId,
    });
  }
  if (comment.promoteStatus === PROMOTE_STATUS.REJECTED) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '该评论已经完成处理，暂不能重复提议',
      requestId,
    });
  }

  if (comment.promoteStatus === PROMOTE_STATUS.NONE) {
    await prisma.comment.update({
      where: { id: comment.id },
      data: { promoteStatus: PROMOTE_STATUS.NOMINATED },
      select: { id: true },
    });
  }

  log.info('api.comment.nominate', 'comment nominated for knowledge extraction', {
    requestId,
    userId: user.id,
    commentId: comment.id,
  });

  return NextResponse.json({
    ok: true,
    commentId: comment.id,
    promoteStatus: comment.promoteStatus === PROMOTE_STATUS.APPROVED
      ? PROMOTE_STATUS.APPROVED
      : PROMOTE_STATUS.NOMINATED,
  });
});
