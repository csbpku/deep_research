// BFF handler: POST /api/researches — 创建调研库草稿
//               GET  /api/researches — 列表查询
//                 ?scope=published（默认）只返回已发布内容
//                 ?scope=draft 只返回当前用户自己的草稿
//
// 契约源：
//   - apps/web/prisma/schema.prisma: Research
//   - docs/contracts/state-machines.md §5: ResearchStatus draft → published
//   - 验收: 草稿仅 owner 可见; creation_method 区分来源
//
// POST: requireUser → zod 解析 → 写入 research + research_audit(action='create')
// GET:  ?type=research|knowledge&scope=published|draft&page=1&limit=20
//       主列表不混入草稿；草稿独立 scope 且仅 owner 可见

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
import { researchListWhere } from '../../../lib/research-list-where';

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
        featuredAt: true,
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
    scope: url.searchParams.get('scope') ?? undefined,
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

  const { type, scope, q, page, limit } = parsed.data;

  // 安全规则：published scope 所有人可见；draft scope 仅 owner 自己可见
  const where = researchListWhere(scope, u.id, type, q);

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
        background: true,
        conclusion: true,
        risks: true,
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
      background: item.background,
      conclusion: item.conclusion,
      risks: item.risks,
      tags: item.tags,
      authorId: item.authorId,
      creationMethod: item.creationMethod,
      aiAssisted: item.aiAssisted,
      publishedAt: item.publishedAt?.toISOString() ?? null,
      featuredAt: item.featuredAt?.toISOString() ?? null,
      canEdit:
        item.authorId === u.id ||
        (u.role === 'admin' && item.status === RESEARCH_STATUS.PUBLISHED),
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
  featuredAt: Date | null;
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
    featuredAt: r.featuredAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    author: { id: r.author.id, name: r.author.name },
  };
}
