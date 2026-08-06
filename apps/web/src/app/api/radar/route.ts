// BFF handler: GET /api/radar — 雷达候选列表（member/admin 可见）。
//
// 契约源：
//   - apps/web/prisma/schema.prisma: 自动雷达 Summary + 已审核用户分享
//   - docs/contracts/state-machines.md §4: SummaryStatus
//
// 入参: ?q=&sourceType=&status=&page=1&per_page=20
// 出参: { items, page, perPage, total, totalPages } —— 每条含 scores、interpretation
//       当前用户已选反馈 + 整体反馈计数。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/db';
import { apiHandler } from '../../../lib/api-handler';
import { getCurrentUser } from '../../../lib/auth/session';
import { toApiErrorResponse } from '../../../lib/errors';
import { withRequestId } from '../../../lib/log';
import { RadarListQuery } from '../../../lib/schemas';
import {
  aggregateFeedbacks,
  matchesQuery,
  shapeCandidate,
} from '../../../lib/radar/shape';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { SUMMARY_STATUS } from '@deep-research/shared/states';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await getCurrentUser();
  // 允许未登录用户查看公开候选

  const url = new URL(req.url);
  const parsed = RadarListQuery.safeParse({
    q: url.searchParams.get('q') ?? undefined,
    sourceType: url.searchParams.get('sourceType') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    quality: url.searchParams.get('quality') ?? undefined,
    dateFrom: url.searchParams.get('dateFrom') ?? undefined,
    page: url.searchParams.get('page') ?? undefined,
    per_page: url.searchParams.get('per_page') ?? undefined,
    includeTotal: url.searchParams.get('includeTotal') ?? undefined,
    includeFeedback: url.searchParams.get('includeFeedback') ?? undefined,
  });
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '查询参数错误',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const {
    q,
    sourceType,
    status,
    quality,
    dateFrom,
    page,
    per_page: perPage,
    includeTotal,
    includeFeedback,
  } = parsed.data;
  if ((status === SUMMARY_STATUS.REJECTED || status === SUMMARY_STATUS.ARCHIVED) && u?.role !== 'admin') {
    return toApiErrorResponse({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: '该状态仅用于 Admin 内容治理',
      requestId,
    });
  }

  // 雷达候选 = 自动雷达条目，或已由 Admin 批准的用户分享。
  // 未审核分享只能停留在 share_submissions，不能出现在公开候选池。
  // 默认排除 archived，让 published/rejected 也可检索（admin 队列场景）。
  const where: Prisma.SummaryWhereInput = {
    // 默认只展示正常雷达内容；已屏蔽/归档条目仅在显式筛选时返回。
    status: status ?? { in: [SUMMARY_STATUS.CANDIDATE, SUMMARY_STATUS.PUBLISHED] },
    AND: [
      {
        OR: [
          { source: 'daily', syncRunId: { not: null } },
          { source: 'user', shareSource: { is: { status: 'approved' } } },
        ],
      },
      ...(sourceType
        ? [{
            OR: [
              {
                syncRun: {
                  source: {
                    sourceType:
                      sourceType === 'github'
                        ? { startsWith: 'github' }
                        : sourceType === 'research'
                          ? 'arxiv'
                        : sourceType === 'articles'
                          ? { in: ['rss', 'devto', 'vendor_news', 'wechat', 'sitemap_watch'] }
                          : sourceType === 'community'
                            ? { in: ['hackernews', 'producthunt', 'reddit', 'lobsters'] }
                            : sourceType === 'shared'
                              ? '__user_share__'
                            : sourceType,
                  },
                },
              },
              ...(sourceType === 'shared'
                ? [{ source: 'user' as const, shareSource: { is: { status: 'approved' as const } } }]
                : sourceType === 'articles' || sourceType === 'web_share'
                ? [{ source: 'user' as const, shareSource: { is: { status: 'approved' as const } } }]
                : []),
            ],
          }]
        : []),
      ...(quality === 'relevant'
        ? [{ OR: [{ distilledTier: { not: 'noise' } }, { distilledTier: null }] }]
        : []),
      ...(dateFrom
        ? [{
            OR: [
              { publishedAt: { gte: dateFrom } },
              { publishedAt: null, createdAt: { gte: dateFrom } },
            ],
          }]
        : []),
      ...(q && q.length > 0
        ? [
            {
              OR: [
                { title: { contains: q, mode: 'insensitive' as Prisma.QueryMode } },
                { interpretation: { contains: q, mode: 'insensitive' as Prisma.QueryMode } },
                { tags: { has: q } },
              ],
            },
          ]
        : []),
    ],
  };

  const orderBy: Prisma.SummaryOrderByWithRelationInput[] = [
    { distilledMustRead: { sort: 'desc', nulls: 'last' } },
    { distilledTotal: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
  ];

  const [rawItems, totalResult] = await Promise.all([
    prisma.summary.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
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
    includeTotal ? prisma.summary.count({ where }) : Promise.resolve(null),
  ]);
  const total = totalResult ?? 0;

  // sourceType is filtered in the Prisma query so pagination and total align.
  const itemsAfterSourceType = rawItems;

  // 二次兜底：DB-side OR 包含 q 的情况下，Postgres `contains` 对 tags 数组敏感不到；
  // 在应用层补做精确匹配。生产可由 pg_trgm 接管（W4 review 决议）。
  const finalItems = itemsAfterSourceType.filter((it) =>
    matchesQuery({
      query: q && q.length > 0 ? q : undefined,
      title: it.title,
      interpretation: it.interpretation,
      tags: it.tags,
    }),
  );

  const summaryIds = finalItems.map((it) => it.id);
  // Only fetch feedbacks if user is logged in (userId must be valid UUID)
  const feedbackMap = includeFeedback && u?.id
    ? await aggregateFeedbacks(prisma, summaryIds, u.id)
    : new Map<string, { counts: Record<string,number>; mine: string[] }>();

  const emptyFeedback = (): { counts: Record<string,number>; mine: string[] } =>
    ({ counts: { useful: 0, inaccurate: 0, used: 0, favorite: 0, suggest_research: 0 }, mine: [] } as const);

  return NextResponse.json({
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
    items: finalItems.map((it) => {
      const fb = feedbackMap.get(it.id) ?? emptyFeedback() as any;
      return shapeCandidate({
        summary: it,
        feedbackCounts: fb.counts,
        myFeedbacks: fb.mine,
        includeBody: false,
      });
    }),
  });
});

// 显式列出 SUMMARY_STATUS 的合法集合，避免被未引用
void SUMMARY_STATUS;
