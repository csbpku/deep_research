// BFF handler: GET /api/admin/radar — Admin 雷达候选队列。
//
// 契约源：
//   - apps/web/prisma/schema.prisma: Summary（雷达字段）
//   - docs/agent-prompts/week5-engineer-a.md §任务 3
//
// 入参: ?status=&sourceType=&page=1&per_page=20
// 出参: items[] 含 scores / interpretation / feedbackCounts / sourceType。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../lib/db';
import { apiHandler } from '../../../../lib/api-handler';
import { requireAdmin } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';
import { RadarListQuery } from '../../../../lib/schemas';
import {
  aggregateFeedbacks,
  matchesQuery,
  normalizeRadarQuery,
  shapeCandidate,
} from '../../../../lib/radar/shape';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const url = new URL(req.url);
  const parsed = RadarListQuery.safeParse({
    q: url.searchParams.get('q') ?? undefined,
    sourceType: url.searchParams.get('sourceType') ?? undefined,
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

  const { q, sourceType, status, page, per_page: perPage } = parsed.data;
  const sourceTypes = Array.isArray(sourceType) ? sourceType : sourceType ? [sourceType] : [];
  const sourceFilters: Prisma.SummaryWhereInput[] = [];
  for (const selectedSource of sourceTypes) {
    if (selectedSource === 'shared' || selectedSource === 'web_share') {
      sourceFilters.push({ source: 'user', shareSource: { is: { status: 'approved' } } });
      continue;
    }
    const sourceTypeFilter: Prisma.StringFilter | string = selectedSource === 'github'
      ? { startsWith: 'github' }
      : selectedSource === 'research'
        ? 'arxiv'
      : selectedSource === 'articles'
        ? { in: ['rss', 'devto', 'vendor_news', 'wechat', 'sitemap_watch'] }
        : selectedSource === 'community'
          ? { in: ['hackernews', 'producthunt', 'reddit', 'lobsters'] }
          : selectedSource;
    sourceFilters.push({ syncRun: { source: { sourceType: sourceTypeFilter } } });
  }
  const effectivePerPage = perPage === 'all' ? 100 : perPage;

  // Admin 默认 status 过滤为 candidate；不传则全部
  const where: Prisma.SummaryWhereInput = {
    ...(status ? { status } : {}),
    AND: [
      {
        OR: [
          { source: 'daily', syncRunId: { not: null } },
          { source: 'user', shareSource: { is: { status: 'approved' } } },
        ],
      },
      ...(sourceFilters.length > 0
        ? [{ OR: sourceFilters }]
        : []),
      ...(q && q.length > 0
        ? [{
            OR: [
              { title: { contains: q, mode: 'insensitive' as Prisma.QueryMode } },
              { title: { contains: normalizeRadarQuery(q), mode: 'insensitive' as Prisma.QueryMode } },
              { url: { contains: q, mode: 'insensitive' as Prisma.QueryMode } },
              { interpretation: { contains: q, mode: 'insensitive' as Prisma.QueryMode } },
              { interpretation: { contains: normalizeRadarQuery(q), mode: 'insensitive' as Prisma.QueryMode } },
              { tags: { hasSome: [q, normalizeRadarQuery(q)] } },
            ],
          }]
        : []),
    ],
  };

  const orderBy: Prisma.SummaryOrderByWithRelationInput[] = [
    { distilledMustRead: { sort: 'desc', nulls: 'last' } },
    { distilledTotal: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
  ];

  const [rawItems, total] = await Promise.all([
    prisma.summary.findMany({
      where,
      orderBy,
      skip: (page - 1) * effectivePerPage,
      take: effectivePerPage,
      select: {
        id: true,
        title: true,
        body: true,
        url: true,
        tags: true,
        status: true,
        summaryDate: true,
        publishedAt: true,
        createdAt: true,
        interpretation: true,
        scoreReason: true,
        scoreVersion: true,
        relevanceScore: true,
        timelinessScore: true,
        sourceQualityScore: true,
        distilledScore: true,
        selectionReason: true,
        sortOrder: true,
        syncRunId: true,
        source: true,
        sharedBy: { select: { id: true, name: true } },
        syncRun: {
          select: {
            id: true,
            completedAt: true,
            source: { select: { sourceType: true, name: true } },
          },
        },
        _count: { select: { comments: true } },
      },
    }),
    prisma.summary.count({ where }),
  ]);

  const finalItems = rawItems.filter((it) =>
    matchesQuery({
      query: q && q.length > 0 ? q : undefined,
      title: it.title,
      url: it.url,
      interpretation: it.interpretation,
      tags: it.tags,
    }),
  );

  const summaryIds = finalItems.map((it) => it.id);
  const feedbackMap = await aggregateFeedbacks(prisma, summaryIds, u.id);

  return NextResponse.json({
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / effectivePerPage)),
    items: finalItems.map((it) => {
      const fb = feedbackMap.get(it.id) ?? {
        counts: { useful: 0, inaccurate: 0, used: 0, favorite: 0, suggest_research: 0 },
        mine: [],
      };
      return shapeCandidate({
        summary: it,
        feedbackCounts: fb.counts,
        myFeedbacks: fb.mine,
        includeBody: false,
      });
    }),
  });
});
