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
import { prisma } from '../../../lib/db';
import { apiHandler, parseBody } from '../../../lib/api-handler';
import { requireUser } from '../../../lib/auth/session';
import { toApiErrorResponse } from '../../../lib/errors';
import { log, withRequestId } from '../../../lib/log';
import { CreateResearchInput, ResearchListQuery } from '../../../lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { RESEARCH_STATUS } from '@deep-research/shared/states';
import { researchListOrderBy, researchListWhere } from '../../../lib/research-list-where';
import { rankResearchForReview } from '../../../lib/research-review-priority';
import { judgementDueSummary } from '../../../lib/research-judgement-due';
import { isLearningReviewDue, isLearningReviewStale, LEARNING_MASTERY_INTERVAL_DAYS } from '../../../lib/learning-review-policy';
import { confirmedKnowledgeIndexText, queuePersonalKnowledgeIndex } from '../../../lib/personal-knowledge-index';

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
        ...(body.type === 'knowledge'
          ? { knowledgeIndexText: confirmedKnowledgeIndexText(body) }
          : {}),
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
    if (body.type === 'knowledge') {
      await queuePersonalKnowledgeIndex(tx, {
        ownerId: u.id,
        researchId: created.id,
        operation: 'upsert',
      });
    }
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
    sort: url.searchParams.get('sort') ?? undefined,
    page: url.searchParams.get('page') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    topicId: url.searchParams.get('topicId') ?? undefined,
    objective: url.searchParams.get('objective') ?? undefined,
    reviewStatus: url.searchParams.get('reviewStatus') ?? undefined,
    hasOpenClaims: url.searchParams.get('hasOpenClaims') ?? undefined,
    needsReview: url.searchParams.get('needsReview') ?? undefined,
    judgementDue: url.searchParams.get('judgementDue') ?? undefined,
  });
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '查询参数错误',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { type, scope, q, sort, page, limit, topicId, objective, reviewStatus, hasOpenClaims, needsReview, judgementDue } = parsed.data;

  // 安全规则：published scope 所有人可见；draft scope 仅 owner 自己可见
  const where = researchListWhere({
    scope, userId: u.id, type, query: q,
    topicId, objective, reviewStatus, hasOpenClaims, needsReview, judgementDue,
  });

  const needsReviewQuery = needsReview === true;
  type ListRow = {
    id: string; type: string; status: string; title: string; body: string;
    background: string | null; conclusion: string | null; risks: string | null;
    tags: string[]; authorId: string; creationMethod: string; aiAssisted: boolean;
    publishedAt: Date | null; featuredAt: Date | null; createdAt: Date; updatedAt: Date;
    author: { id: string; name: string; email: string };
    learningSelfChecks?: { rating: string; updatedAt: Date }[];
    judgement?: string | null; judgementConfidence?: string | null;
    judgementScope?: string | null; judgementReviewAt?: Date | null;
  };
  let items: ListRow[];
  let total: number;
  if (needsReviewQuery) {
    // Rank every matching article in the database, not just the current page.
    // Ratings are per user, so a column on Research would be wrong; group the
    // small rating table first and rank the candidate ids in memory.
    // Weak answers are due now; mastered answers come back after the interval.
    const masteryCutoff = new Date(Date.now() - LEARNING_MASTERY_INTERVAL_DAYS * 86_400_000);
    const [grouped, mastered] = await Promise.all([
      prisma.learningSelfCheck.groupBy({
        by: ['researchId', 'rating'],
        where: { userId: u.id, rating: { in: ['unsure', 'missed'] } },
        _count: { _all: true },
        _min: { firstMissedAt: true, updatedAt: true },
      }),
      prisma.learningSelfCheck.findMany({
        where: { userId: u.id, rating: 'got_it', masteredAt: { not: null } },
        select: { researchId: true, masteredAt: true, masteryCount: true },
      }),
    ]);
    const stats = new Map<string, { rating: string; updatedAt: Date }[]>();
    for (const row of grouped) {
      const list = stats.get(row.researchId) ?? [];
      for (let index = 0; index < row._count._all; index++) {
        list.push({ rating: row.rating, updatedAt: row._min.firstMissedAt ?? row._min.updatedAt ?? new Date(0) });
      }
      stats.set(row.researchId, list);
    }
    for (const row of mastered) {
      // The SQL gate above can only use the shortest interval; the real due
      // date depends on how many times this question has been retired.
      if (!isLearningReviewDue(row.masteredAt, new Date(), LEARNING_MASTERY_INTERVAL_DAYS, row.masteryCount)) continue;
      const list = stats.get(row.researchId) ?? [];
      list.push({ rating: 'got_it', updatedAt: row.masteredAt ?? masteryCutoff });
      stats.set(row.researchId, list);
    }
    // Only articles this user has actually rated can be "needs review".
    // Fetching the whole research table just to sort it was the old cost.
    const candidates = stats.size === 0
      ? []
      : await prisma.research.findMany({
        where: { AND: [where, { id: { in: [...stats.keys()] } }] },
        select: { id: true, updatedAt: true },
      });
    const ranked = rankResearchForReview(
      candidates.map(candidate => ({
        id: candidate.id,
        updatedAt: candidate.updatedAt,
        learningSelfChecks: stats.get(candidate.id) ?? [],
      })),
    );
    total = ranked.length;
    const pageIds = ranked.slice((page - 1) * limit, page * limit).map(item => item.id);
    const rows = await prisma.research.findMany({
      where: { id: { in: pageIds } },
      select: {
        id: true, type: true, status: true, title: true, body: true, background: true,
        conclusion: true, risks: true, tags: true, authorId: true, creationMethod: true,
        aiAssisted: true, publishedAt: true, featuredAt: true, createdAt: true, updatedAt: true,
        author: { select: { id: true, name: true, email: true } },
        learningSelfChecks: {
          where: {
            userId: u.id,
            OR: [
              { rating: { in: ['unsure', 'missed'] } },
              { masteredAt: { not: null } },
            ],
          },
          select: { rating: true, updatedAt: true, firstMissedAt: true, masteredAt: true },
        },
      },
    });
    const byId = new Map(rows.map(row => [row.id, row]));
    items = pageIds.map(id => byId.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  } else {
    const [rows, count] = await Promise.all([
      prisma.research.findMany({
        where,
        orderBy: researchListOrderBy(sort),
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, type: true, status: true, title: true, body: true, background: true,
          conclusion: true, risks: true, tags: true, authorId: true, creationMethod: true,
          aiAssisted: true, publishedAt: true, featuredAt: true, createdAt: true, updatedAt: true,
          judgement: true, judgementConfidence: true, judgementScope: true, judgementReviewAt: true,
          author: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.research.count({ where }),
    ]);
    items = rows;
    total = count;
  }

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
      ...(needsReviewQuery ? (() => {
        const checks = (item as { learningSelfChecks?: { rating: string; updatedAt: Date; firstMissedAt: Date | null; masteredAt: Date | null }[] }).learningSelfChecks ?? [];
        const oldest = checks.reduce<Date | null>((acc, check) => { const at = check.firstMissedAt ?? check.updatedAt; return !acc || at < acc ? at : acc; }, null);
        const masteryDue = checks.filter(check => check.rating === 'got_it' && isLearningReviewDue(check.masteredAt)).length;
        return {
          reviewDue: {
            missed: checks.filter(check => check.rating === 'missed').length,
            unsure: checks.filter(check => check.rating === 'unsure').length,
            masteryDue,
            stale: isLearningReviewStale(oldest),
          },
        };
      })() : {}),
      ...('judgementReviewAt' in item && item.judgementReviewAt ? { judgementDue: judgementDueSummary(item) } : {}),
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
