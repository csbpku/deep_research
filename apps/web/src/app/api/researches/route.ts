// BFF handler: POST /api/researches — 创建沉淀草稿
//               GET  /api/researches — 列表查询（已发布 + 自己草稿）
//
// 契约源：
//   - apps/web/prisma/schema.prisma: Research
//   - docs/contracts/state-machines.md §5: ResearchStatus draft → published
//   - 验收: 草稿仅 owner 可见; creation_method 区分来源
//
// POST: requireUser → zod 解析 → 写入 research + research_audit(action='create')
// GET:  ?type=research|knowledge&page=1&limit=20
//       返回已发布的全部 + 自己的 draft（不会泄露他人的 draft）

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/db';
import { apiHandler, parseBody } from '../../../lib/api-handler';
import { requireUser } from '../../../lib/auth/session';
import { toApiErrorResponse } from '../../../lib/errors';
import { log, withRequestId } from '../../../lib/log';
import { CreateResearchInput, ResearchListQuery } from '../../../lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { RESEARCH_STATUS } from '@deep-research/shared/states';

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const body = await parseBody(req, CreateResearchInput);
  if (body instanceof NextResponse) return body;

  const research = await prisma.$transaction(async (tx) => {
    const created = await tx.research.create({
      data: {
        type: body.type,
        title: body.title,
        body: body.body,
        background: body.background ?? null,
        conclusion: body.conclusion ?? null,
        risks: body.risks ?? null,
        tags: body.tags,
        authorId: u.id,
        status: 'draft',
        creationMethod: 'manual',
        aiAssisted: false,
      },
      select: {
        id: true,
        type: true,
        status: true,
        title: true,
        body: true,
        background: true,
        conclusion: true,
        risks: true,
        tags: true,
        authorId: true,
        creationMethod: true,
        aiAssisted: true,
        publishedAt: true,
        createdAt: true,
        updatedAt: true,
        author: { select: { id: true, name: true, email: true } },
      },
    });
    await tx.researchAudit.create({
      data: {
        researchId: created.id,
        editorId: u.id,
        action: 'create',
      },
    });
    return created;
  });

  log.info('research.create', 'draft created', {
    requestId,
    userId: u.id,
    researchId: research.id,
    creationMethod: 'manual',
  });

  return NextResponse.json(shapeResearch(research), { status: 201 });
});

// ─── GET /api/researches ──────────────────────────────────────────────

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const url = new URL(req.url);
  const parsed = ResearchListQuery.safeParse({
    type: url.searchParams.get('type') ?? undefined,
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

  const { type, page, limit } = parsed.data;

  // 安全规则：只能看到 published 的，或者自己 authored 的 draft
  const where: Prisma.ResearchWhereInput = {
    AND: [
      ...(type ? [{ type: type as Prisma.EnumResearchTypeFilter['equals'] }] : []),
      {
        OR: [
          { status: RESEARCH_STATUS.PUBLISHED as Prisma.EnumResearchStatusFilter['equals'] },
          { authorId: u.id, status: { equals: 'draft' } },
        ],
      },
    ],
  };

  const [items, total] = await Promise.all([
    prisma.research.findMany({
      where,
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        type: true,
        status: true,
        title: true,
        body: true,
        background: true,
        conclusion: true,
        risks: true,
        tags: true,
        authorId: true,
        creationMethod: true,
        aiAssisted: true,
        publishedAt: true,
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
      background: item.background,
      conclusion: item.conclusion,
      risks: item.risks,
      tags: item.tags,
      authorId: item.authorId,
      creationMethod: item.creationMethod,
      aiAssisted: item.aiAssisted,
      publishedAt: item.publishedAt?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      author: { id: item.author.id, name: item.author.name },
    })),
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
});

// ──────────────────────────────────────────────────────────────────────
// Research → API response shape
// ──────────────────────────────────────────────────────────────────────

function shapeResearch(r: {
  id: string;
  type: string;
  status: string;
  title: string;
  body: string;
  background: string | null;
  conclusion: string | null;
  risks: string | null;
  tags: string[];
  authorId: string;
  creationMethod: string;
  aiAssisted: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  author: { id: string; name: string; email: string };
}) {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    title: r.title,
    body: r.body,
    background: r.background,
    conclusion: r.conclusion,
    risks: r.risks,
    tags: r.tags,
    authorId: r.authorId,
    creationMethod: r.creationMethod,
    aiAssisted: r.aiAssisted,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    author: { id: r.author.id, name: r.author.name },
  };
}
