// BFF handler: GET/POST /api/summaries/[id]/comments —— 摘要评论列表与创建。
//
// 契约源：
//   - apps/web/prisma/schema.prisma: Comment（researchId/summaryId 恰好一个非空，CHECK 约束）
//   - docs/IMPLEMENTATION_PLAN.md §十 (Week 8)
//
// 权限：requireUser 即可（评论成员可见/可发）；admin 无特权。
// 嵌套：parentId 可选；列表只取 top-level，回复通过 GET /api/comments/[id]/thread 获取。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../../lib/db';
import { apiHandler, parseBody } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { log, withRequestId } from '../../../../../lib/log';
import { CommentListQuery, CreateCommentInput, SummaryIdParam } from '../../../../../lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const GET = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  // 评论对登录用户开放
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const idParsed = SummaryIdParam.safeParse(await ctx.params);
  if (!idParsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: idParsed.error.flatten(),
    });
  }

  const url = new URL(req.url);
  const parsed = CommentListQuery.safeParse({
    page: url.searchParams.get('page') ?? undefined,
    per_page: url.searchParams.get('per_page') ?? undefined,
    sort: url.searchParams.get('sort') ?? undefined,
  });
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '查询参数不合法',
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { page, per_page, sort } = parsed.data;

  // 先校验 summary 存在（published 状态才允许评论）
  const summary = await prisma.summary.findUnique({
    where: { id: idParsed.data.id },
    select: { id: true, status: true },
  });
  if (!summary || summary.status !== 'published') {
    return toApiErrorResponse({
      code: ERROR_CODES.NOT_FOUND,
      message: '摘要不存在或未发布',
      requestId,
    });
  }

  // top-level（parentId IS NULL）的评论，按时间排序
  const orderBy = sort === 'oldest' ? { createdAt: 'asc' as const } : { createdAt: 'desc' as const };
  const [total, items] = await Promise.all([
    prisma.comment.count({
      where: { summaryId: idParsed.data.id, parentId: null },
    }),
    prisma.comment.findMany({
      where: { summaryId: idParsed.data.id, parentId: null },
      orderBy,
      skip: (page - 1) * per_page,
      take: per_page,
      select: {
        id: true,
        body: true,
        parentId: true,
        starCount: true,
        promoteStatus: true,
        createdAt: true,
        author: { select: { id: true, name: true, avatarUrl: true } },
        children: {
          select: {
            id: true,
            body: true,
            starCount: true,
            createdAt: true,
            author: { select: { id: true, name: true, avatarUrl: true } },
          },
          orderBy: { createdAt: 'asc' as const },
          take: 3, // 默认展示前 3 条回复，更多可展开
        },
        _count: { select: { children: true } },
      },
    }),
  ]);

  return NextResponse.json({
    page,
    perPage: per_page,
    total,
    totalPages: Math.ceil(total / per_page),
    items: items.map(serializeComment),
  });
});

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const idParsed = SummaryIdParam.safeParse(await ctx.params);
  if (!idParsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: idParsed.error.flatten(),
    });
  }

  const body = await parseBody(req, CreateCommentInput);
  if (body instanceof NextResponse) return body;

  // 校验 summary 存在且已发布
  const summary = await prisma.summary.findUnique({
    where: { id: idParsed.data.id },
    select: { id: true, status: true },
  });
  if (!summary || summary.status !== 'published') {
    return toApiErrorResponse({
      code: ERROR_CODES.NOT_FOUND,
      message: '摘要不存在或未发布',
      requestId,
    });
  }

  // 校验 parentId：必须指向同 summary 的评论
  if (body.parentId) {
    const parent = await prisma.comment.findUnique({
      where: { id: body.parentId },
      select: { id: true, summaryId: true, researchId: true },
    });
    if (!parent || parent.summaryId !== idParsed.data.id) {
      return toApiErrorResponse({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'parentId 无效',
        requestId,
      });
    }
  }

  const created = await prisma.comment.create({
    data: {
      authorId: u.id,
      targetType: 'summary',
      summaryId: idParsed.data.id,
      body: body.body,
      parentId: body.parentId ?? null,
    },
    select: {
      id: true,
      body: true,
      parentId: true,
      starCount: true,
      promoteStatus: true,
      createdAt: true,
      author: { select: { id: true, name: true, avatarUrl: true } },
    },
  });

  // 增加 Research.commentCount（用于沉淀详情统计口径）
  // 但 summary.commentCount 不存在（schema 没有该字段）。如果日后加入，可在这里同步。

  log.info('api.summary.comment.create', 'summary comment created', {
    requestId,
    userId: u.id,
    summaryId: idParsed.data.id,
    commentId: created.id,
    isReply: Boolean(body.parentId),
  });

  return NextResponse.json({ ok: true, comment: serializeComment({ ...created, children: [], _count: { children: 0 } }) }, { status: 201 });
});

function serializeComment(c: {
  id: string;
  body: string;
  parentId: string | null;
  starCount: number;
  promoteStatus: string;
  createdAt: Date;
  author: { id: string; name: string; avatarUrl: string | null };
  children?: Array<{
    id: string;
    body: string;
    starCount: number;
    createdAt: Date;
    author: { id: string; name: string; avatarUrl: string | null };
  }>;
  _count?: { children: number };
}) {
  return {
    id: c.id,
    body: c.body,
    parentId: c.parentId,
    starCount: c.starCount,
    promoteStatus: c.promoteStatus,
    createdAt: c.createdAt.toISOString(),
    author: c.author,
    children: (c.children ?? []).map((r) => ({
      id: r.id,
      body: r.body,
      starCount: r.starCount,
      createdAt: r.createdAt.toISOString(),
      author: r.author,
    })),
    childCount: c._count?.children ?? c.children?.length ?? 0,
  };
}