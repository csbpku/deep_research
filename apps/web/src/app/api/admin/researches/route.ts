// BFF handler: GET /api/admin/researches — Admin 调研库管理列表。
//
// 与成员列表不同：默认返回全部状态（草稿 / 已发布 / 已归档），
// 仅 admin 可见；支持 status / type / q 服务端筛选与分页。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../lib/db';
import { apiHandler } from '../../../../lib/api-handler';
import { requireAdmin } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';
import { AdminResearchListQuery } from '../../../../lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const url = new URL(req.url);
  const parsed = AdminResearchListQuery.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    type: url.searchParams.get('type') ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
    page: url.searchParams.get('page') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '查询参数错误',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { status, type, q, page, limit } = parsed.data;
  const where: Prisma.ResearchWhereInput = {
    AND: [
      ...(status !== 'all'
        ? [{ status: { equals: status as Prisma.EnumResearchStatusFilter['equals'] } }]
        : []),
      ...(type
        ? [{ type: { equals: type as Prisma.EnumResearchTypeFilter['equals'] } }]
        : []),
      ...(q
        ? [{
            OR: [
              { title: { contains: q, mode: 'insensitive' as Prisma.QueryMode } },
              { body: { contains: q, mode: 'insensitive' as Prisma.QueryMode } },
              { tags: { has: q } },
            ],
          }]
        : []),
    ],
  };

  const [items, total] = await Promise.all([
    prisma.research.findMany({
      where,
      orderBy: [
        { featuredAt: { sort: 'desc', nulls: 'last' } },
        { publishedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        type: true,
        status: true,
        title: true,
        body: true,
        tags: true,
        authorId: true,
        creationMethod: true,
        aiAssisted: true,
        publishedAt: true,
        featuredAt: true,
        createdAt: true,
        updatedAt: true,
        author: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.research.count({ where }),
  ]);

  return NextResponse.json({
    items: items.map((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      title: item.title,
      body: item.body,
      tags: item.tags,
      authorId: item.authorId,
      creationMethod: item.creationMethod,
      aiAssisted: item.aiAssisted,
      publishedAt: item.publishedAt?.toISOString() ?? null,
      featuredAt: item.featuredAt?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      author: { id: item.author.id, name: item.author.name },
    })),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});
