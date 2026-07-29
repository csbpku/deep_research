// BFF handler: GET /api/admin/comments — Admin 评论提名队列（待提炼精华）。
//
// 契约源：apps/web/prisma/schema.prisma::Comment.promoteStatus
// 入参: ?status=pending|approved|rejected|all（默认 pending）
// 出参: items[] 含作者 + 目标实体（summary/research）信息 + 评论体

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../lib/db';
import { apiHandler } from '../../../../lib/api-handler';
import { requireAdmin } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';
import { AdminCommentListQuery } from '../../../../lib/schemas';
import { PROMOTE_STATUS } from '@deep-research/shared/states';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const url = new URL(req.url);
  const parsed = AdminCommentListQuery.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    page: url.searchParams.get('page') ?? undefined,
    per_page: url.searchParams.get('per_page') ?? undefined,
  });
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '查询参数错误',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { status, page, per_page: perPage } = parsed.data;

  const where: Prisma.CommentWhereInput =
    status === 'pending'
      ? {
          promoteStatus: PROMOTE_STATUS.NOMINATED,
        }
      : status === 'approved'
        ? { promoteStatus: PROMOTE_STATUS.APPROVED }
        : status === 'rejected'
          ? { promoteStatus: PROMOTE_STATUS.REJECTED }
          : {};

  const [items, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        body: true,
        starCount: true,
        promoteStatus: true,
        targetType: true,
        summaryId: true,
        researchId: true,
        createdAt: true,
        author: { select: { id: true, name: true, email: true } },
        summary: { select: { id: true, title: true } },
        research: { select: { id: true, title: true } },
      },
    }),
    prisma.comment.count({ where }),
  ]);

  return NextResponse.json({
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
    items: items.map((it) => ({
      id: it.id,
      body: it.body,
      starCount: it.starCount,
      promoteStatus: it.promoteStatus,
      targetType: it.targetType,
      summary: it.summary,
      research: it.research,
      createdAt: it.createdAt.toISOString(),
      author: it.author,
    })),
  });
});