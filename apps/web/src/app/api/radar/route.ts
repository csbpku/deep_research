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
  normalizeRadarQuery,
  shapeCandidate,
} from '../../../lib/radar/shape';
import {
  RADAR_ARTICLE_SOURCE_TYPES,
  RADAR_COMMUNITY_SOURCE_TYPES,
  RADAR_RESEARCH_SOURCE_TYPES,
} from '../../../lib/radar/source-labels';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { SUMMARY_STATUS } from '@deep-research/shared/states';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await getCurrentUser();
  // 允许未登录用户查看公开候选

  const url = new URL(req.url);
  const parsed = RadarListQuery.safeParse({
    q: url.searchParams.get('q') ?? undefined,
    sourceType: (() => {
      const values = url.searchParams.getAll('sourceType');
      return values.length > 1 ? values : values[0] ?? undefined;
    })(),
    status: url.searchParams.get('status') ?? undefined,
    quality: (() => {
      const values = url.searchParams.getAll('quality');
      if (values.length > 1) return values;
      const value = values[0];
      return value?.includes(',') ? value.split(',') : value;
    })(),
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
  const requestedQualityValues = Array.isArray(quality) ? quality : [quality];
  // Noise is an admin/audit state, never a member-facing radar state.
  // Keep the explicit noise filter available to Admin tools, but do not let
  // it leak into the public list through quality=all or admin_promoted.
  const qualityValues = u?.role === 'admin'
    ? requestedQualityValues
    : requestedQualityValues.filter((value) => value !== 'noise');
  const sourceTypes = Array.isArray(sourceType) ? sourceType : sourceType ? [sourceType] : [];
  const hackerNewsSource = {
    name: { contains: 'Hacker News', mode: 'insensitive' as Prisma.QueryMode },
  } satisfies Prisma.RadarSourceWhereInput;
  const articleSource = {
    AND: [
      { sourceType: { in: [...RADAR_ARTICLE_SOURCE_TYPES] } },
      { NOT: hackerNewsSource },
    ],
  } satisfies Prisma.RadarSourceWhereInput;
  const communitySource = {
    OR: [
      { sourceType: { in: [...RADAR_COMMUNITY_SOURCE_TYPES] } },
      {
        AND: [
          { sourceType: { in: [...RADAR_ARTICLE_SOURCE_TYPES] } },
          hackerNewsSource,
        ],
      },
    ],
  } satisfies Prisma.RadarSourceWhereInput;
  const sourceFilterForCategory = (selectedSource: string): Prisma.SummaryWhereInput[] => {
    const sourceWhere = selectedSource === 'github'
      ? { sourceType: { startsWith: 'github' } }
      : selectedSource === 'research'
        ? { sourceType: { in: [...RADAR_RESEARCH_SOURCE_TYPES] } }
        : selectedSource === 'articles'
          ? articleSource
          : selectedSource === 'community'
            ? communitySource
            : selectedSource === 'shared'
              ? null
              : { sourceType: selectedSource };
    return sourceWhere ? [{ syncRun: { source: sourceWhere } }] : [];
  };
  const qualityWhere = qualityValues.length === 0 && requestedQualityValues.some(Boolean)
    ? { id: { in: [] } } satisfies Prisma.SummaryWhereInput
    : qualityValues.includes('all')
    ? null
    : {
        OR: [
          ...(qualityValues.includes('valuable')
            ? [{ distilledTier: { in: ['collection', 'deep_read'] } }]
            : []),
          ...(qualityValues.some((value) => ['collection', 'deep_read', 'skim', 'noise'].includes(value))
            ? [{ distilledTier: { in: qualityValues.filter((value): value is 'collection' | 'deep_read' | 'skim' | 'noise' => ['collection', 'deep_read', 'skim', 'noise'].includes(value)) } }]
            : []),
          ...(qualityValues.includes('pending') ? [{ distilledTier: null }] : []),
        ],
      } satisfies Prisma.SummaryWhereInput;
  const nonReaderGithubItem = {
    OR: [
      { originalKind: { in: ['github_issue', 'github_pr', 'github_release'] } },
      { canonicalUrl: { contains: '/issues/' } },
      { canonicalUrl: { contains: '/pull/' } },
      { canonicalUrl: { contains: '/releases/tag/' } },
    ],
  } satisfies Prisma.SummaryWhereInput;
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
      ...(sourceTypes.length > 0
        ? [{
          OR: sourceTypes.flatMap((selectedSource) => {
            return [
              ...sourceFilterForCategory(selectedSource),
              ...(selectedSource === 'shared'
                ? [{ source: 'user' as const, shareSource: { is: { status: 'approved' as const } } }]
                : selectedSource === 'articles' || selectedSource === 'web_share'
                ? [{ source: 'user' as const, shareSource: { is: { status: 'approved' as const } } }]
                : []),
            ];
          }),
        }]
        : []),
      ...(qualityWhere ? [qualityWhere] : []),
      // GitHub Issue/PR/Release are governance signals, not durable Radar
      // reading assets. Keep them in Admin, but do not mix them into the
      // member-facing stream. URL fallbacks cover historical rows that were
      // persisted as github_other before the classifier was fixed.
      { NOT: nonReaderGithubItem },
      // Public radar contains only scored, reader-facing tiers. Noise and
      // pending/unscored rows remain available to Admin governance tools.
      ...(u?.role !== 'admin'
        ? [{ distilledTier: { in: ['collection', 'deep_read', 'skim'] } }]
        : []),
      // Recent repository activity is rendered inside the project reader.
      // Keep legacy daily digest rows out of the main stream so one repo has
      // one durable entry instead of a new card every sync.
      { NOT: { tags: { has: 'repo_digest' } } },
      ...(dateFrom
        ? [{
            // “今天/近 N 天”按入库时间筛选，和 Admin 的“今日写入”保持一致。
            // publishedAt 是来源文章的原始发布时间，可能早于实际入库日期。
            createdAt: { gte: dateFrom },
          }]
        : []),
      ...(q && q.length > 0
        ? [
            {
              OR: [
                { title: { contains: q, mode: 'insensitive' as Prisma.QueryMode } },
                { title: { contains: normalizeRadarQuery(q), mode: 'insensitive' as Prisma.QueryMode } },
                { url: { contains: q, mode: 'insensitive' as Prisma.QueryMode } },
                { interpretation: { contains: q, mode: 'insensitive' as Prisma.QueryMode } },
                { interpretation: { contains: normalizeRadarQuery(q), mode: 'insensitive' as Prisma.QueryMode } },
                { tags: { hasSome: [q, normalizeRadarQuery(q)] } },
              ],
            },
          ]
        : []),
    ],
  };

  const orderBy: Prisma.SummaryOrderByWithRelationInput[] = [
    { distilledTotal: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
  ];

  const [rawItems, totalResult] = await Promise.all([
    prisma.summary.findMany({
      where,
      orderBy,
      skip: perPage === 'all' ? 0 : (page - 1) * perPage,
      ...(perPage === 'all' ? {} : { take: perPage }),
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
        updatedAt: true,
        interpretation: true,
        scoreReason: true,
        scoreVersion: true,
        relevanceScore: true,
        timelinessScore: true,
        sourceQualityScore: true,
        distilledScore: true,
        distilledTier: true,
        selectionReason: true,
        sortOrder: true,
        syncRunId: true,
        source: true,
        readerQualityStatus: true,
        readerQualityDetails: true,
        contentReviewStatus: true,
        contentReviewRound: true,
        contentReviewDetails: true,
        renderReviewStatus: true,
        renderReviewRound: true,
        sharedBy: { select: { id: true, name: true } },
        syncRun: {
          select: {
            id: true,
            completedAt: true,
            source: { select: { sourceType: true, name: true } },
          },
        },
        _count: { select: { comments: true } },
        // ADR 0010: 雷达候选附带的专题与热点议题标签
        topicLinks: {
          select: {
            topic: {
              select: { id: true, slug: true, name: true, tier: true },
            },
          },
          take: 6,
        },
        issueCandidates: {
          where: { issue: { status: 'active' } },
          select: {
            issue: {
              select: {
                id: true,
                title: true,
                kind: true,
                importanceScore: true,
                topicId: true,
                topic: { select: { id: true, slug: true, name: true } },
              },
            },
          },
          take: 6,
        },
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
      url: it.url,
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
    totalPages: perPage === 'all' ? 1 : Math.max(1, Math.ceil(total / perPage)),
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
