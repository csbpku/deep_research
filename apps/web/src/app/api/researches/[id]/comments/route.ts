// BFF handler: GET/POST /api/researches/[id]/comments —— 沉淀评论列表与创建。
//
// 与 /api/summaries/[id]/comments 对称。差异：
//   - 校验沉淀存在 + status='published'
//   - 同时更新 Research.commentCount（schema 已包含该字段）

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../../lib/db';
import { apiHandler, parseBody } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { log, withRequestId } from '../../../../../lib/log';
import { CommentListQuery, CreateCommentInput, ResearchIdParam } from '../../../../../lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const GET = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const idParsed = ResearchIdParam.safeParse(await ctx.params);
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
  const orderBy = sort === 'oldest' ? { createdAt: 'asc' as const } : { createdAt: 'desc' as const };

  const research = await prisma.research.findUnique({
    where: { id: idParsed.data.id },
    select: { id: true, status: true },
  });
  if (!research || research.status !== 'published') {
    return toApiErrorResponse({
      code: ERROR_CODES.NOT_FOUND,
      message: '沉淀不存在或未发布',
      requestId,
    });
  }

  const [total, items] = await Promise.all([
    prisma.comment.count({
      where: { researchId: idParsed.data.id, parentId: null },
    }),
    prisma.comment.findMany({
      where: { researchId: idParsed.data.id, parentId: null },
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
          take: 3,
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

  const idParsed = ResearchIdParam.safeParse(await ctx.params);
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

  const research = await prisma.research.findUnique({
    where: { id: idParsed.data.id },
    select: { id: true, status: true },
  });
  if (!research || research.status !== 'published') {
    return toApiErrorResponse({
      code: ERROR_CODES.NOT_FOUND,
      message: '沉淀不存在或未发布',
      requestId,
    });
  }

  if (body.parentId) {
    const parent = await prisma.comment.findUnique({
      where: { id: body.parentId },
      select: { id: true, researchId: true, summaryId: true },
    });
    if (!parent || parent.researchId !== idParsed.data.id) {
      return toApiErrorResponse({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'parentId 无效',
        requestId,
      });
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const c = await tx.comment.create({
      data: {
        authorId: u.id,
        targetType: 'research',
        researchId: idParsed.data.id,
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
    // 增加沉淀评论计数
    await tx.research.update({
      where: { id: idParsed.data.id },
      data: { commentCount: { increment: 1 } },
      select: { id: true },
    });
    return c;
  });

  log.info('api.research.comment.create', 'research comment created', {
    requestId,
    userId: u.id,
    researchId: idParsed.data.id,
    commentId: created.id,
    isReply: Boolean(body.parentId),
  });

  return NextResponse.json(
    { ok: true, comment: serializeComment({ ...created, children: [], _count: { children: 0 } }) },
    { status: 201 },
  );
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