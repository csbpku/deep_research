// BFF handler: GET/POST /api/summaries/[id]/comments.
//
// Despite the historical route name, this is the shared comment endpoint for
// radar candidates and approved user-shared summaries. It is not a daily
// digest endpoint.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { prisma } from '../../../../../lib/db';
import { apiHandler, parseBody } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { log, withRequestId } from '../../../../../lib/log';
import { CommentListQuery, CreateCommentInput, SummaryIdParam } from '../../../../../lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { createCommentMentionsAndNotifications } from '../../../../../lib/comments/notifications';

type SummaryRef = {
  status: string;
  source: string;
  syncRunId: string | null;
  shareSource: { status: string } | null;
};

function isCommentableSummary(summary: SummaryRef | null): summary is SummaryRef {
  return Boolean(
    summary
      && (
        summary.status === 'published'
        || (summary.source === 'daily' && summary.syncRunId !== null)
        || (summary.source === 'user' && summary.shareSource?.status === 'approved')
      ),
  );
}

function serializeComment(c: {
  id: string;
  body: string;
  parentId: string | null;
  starCount: number;
  promoteStatus: string;
  createdAt: Date;
  author: { id: string; name: string; avatarUrl: string | null };
  mentions?: Array<{ user: { id: string; name: string; avatarUrl: string | null } }>;
  children?: Array<{
    id: string;
    body: string;
    starCount: number;
    createdAt: Date;
    author: { id: string; name: string; avatarUrl: string | null };
    mentions?: Array<{ user: { id: string; name: string; avatarUrl: string | null } }>;
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
    mentions: c.mentions?.map((mention) => mention.user) ?? [],
    children: (c.children ?? []).map((reply) => ({
      id: reply.id,
      body: reply.body,
      starCount: reply.starCount,
      createdAt: reply.createdAt.toISOString(),
      author: reply.author,
      mentions: reply.mentions?.map((mention) => mention.user) ?? [],
    })),
    childCount: c._count?.children ?? c.children?.length ?? 0,
  };
}

async function loadSummary(id: string): Promise<SummaryRef | null> {
  return prisma.summary.findUnique({
    where: { id },
    select: {
      status: true,
      source: true,
      syncRunId: true,
      shareSource: { select: { status: true } },
    },
  });
}

export const GET = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

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
  if (!isCommentableSummary(await loadSummary(idParsed.data.id))) {
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: '摘要不存在或不可评论', requestId });
  }

  const { page, per_page, sort } = parsed.data;
  const orderBy = sort === 'oldest'
    ? { createdAt: 'asc' as const }
    : { createdAt: 'desc' as const };
  const [total, items] = await Promise.all([
    prisma.comment.count({ where: { summaryId: idParsed.data.id, parentId: null } }),
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
        mentions: { select: { user: { select: { id: true, name: true, avatarUrl: true } } } },
        children: {
          select: {
            id: true,
            body: true,
            starCount: true,
            createdAt: true,
            author: { select: { id: true, name: true, avatarUrl: true } },
            mentions: { select: { user: { select: { id: true, name: true, avatarUrl: true } } } },
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
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

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
  if (!isCommentableSummary(await loadSummary(idParsed.data.id))) {
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: '摘要不存在或不可评论', requestId });
  }

  let parentAuthorId: string | null = null;
  if (body.parentId) {
    const parent = await prisma.comment.findUnique({
      where: { id: body.parentId },
      select: { summaryId: true, authorId: true },
    });
    if (!parent || parent.summaryId !== idParsed.data.id) {
      return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: 'parentId 无效', requestId });
    }
    parentAuthorId = parent.authorId;
  }

  const created = await prisma.$transaction(async (tx) => {
    const comment = await tx.comment.create({
      data: {
        authorId: user.id,
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
    await createCommentMentionsAndNotifications({
      tx,
      commentId: comment.id,
      body: body.body,
      actorId: user.id,
      mentionedUserIds: body.mentionedUserIds,
      parentAuthorId,
    });
    return comment;
  });

  log.info('api.summary.comment.create', 'summary comment created', {
    requestId,
    userId: user.id,
    summaryId: idParsed.data.id,
    commentId: created.id,
    isReply: Boolean(body.parentId),
  });
  return NextResponse.json(
    { ok: true, comment: serializeComment({ ...created, children: [], _count: { children: 0 } }) },
    { status: 201 },
  );
});
