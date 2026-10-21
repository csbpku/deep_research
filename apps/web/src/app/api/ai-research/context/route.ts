// BFF handler: GET /api/ai-research/context — 自动上下文（ADR 0010）。
//
// 输入：?q=...&topicHint=...（兼容 topicId）；manual=1 允许搜索公开研究，
// semantic=1 可额外使用个人语义索引，自动建议不依赖该服务。
// 输出：建议的历史研究、匹配议题、关联 Topic、用户收藏。
// 权限：仅返回公开 Research / Knowledge + 当前用户自己的私有草稿与收藏。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { fetchAiEngine } from '@/lib/ai-bff/fetch-ai-engine';
import { getWebEnv } from '@/lib/env';
import { withRequestId } from '@/lib/log';
import {
  extractPersonalContextKeywords,
  findPersonalContext,
  PERSONAL_CONTEXT_LIMITS,
  personalContextTextScore,
} from '@/lib/personal-context-relevance';

interface RowBase {
  id: string;
  title: string;
  snippet: string;
  url?: string | null;
  updatedAt?: string | null;
}

type ContextSourceRef = {
  type: 'research' | 'summary';
  value: string;
  required: false;
};

export const dynamic = 'force-dynamic';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const url = new URL(req.url);
  const query = (url.searchParams.get('q') ?? '').slice(0, PERSONAL_CONTEXT_LIMITS.query).trim();
  if (query.length < 2) {
    return NextResponse.json({ items: [], topics: [] });
  }
  const rawTopic = url.searchParams.get('topicHint') ?? url.searchParams.get('topicId');
  const topicParam = rawTopic && /^[0-9a-f-]{36}$/iu.test(rawTopic) ? rawTopic : undefined;
  const keywords = extractPersonalContextKeywords(query);
  if (!keywords.length && !topicParam) return NextResponse.json({ items: [], topics: [] });
  // Automatic suggestions are local-only. The optional personal index is never
  // a prerequisite for discovering a saved judgment.
  const semanticPromise = url.searchParams.get('semantic') === '1'
    ? findSemanticKnowledge(query, u.id, withRequestId(req.headers))
    : Promise.resolve([]);
  const manualSearch = url.searchParams.get('manual') === '1';

  const [personalItems, issues, bookmarks] = await Promise.all([
    findPersonalContext(u.id, query, topicParam ? [topicParam] : [], manualSearch),
    prisma.topicIssue.findMany({
      where: {
        status: 'active',
        topic: { enabled: true },
        OR: [
          ...keywords.flatMap((keyword) => [
            { title: { contains: keyword, mode: 'insensitive' as const } },
            { proposition: { contains: keyword, mode: 'insensitive' as const } },
          ]),
          ...(topicParam ? [{ topicId: topicParam }] : []),
        ],
      },
      orderBy: { importanceScore: 'desc' },
      take: 8,
      select: {
        id: true,
        title: true,
        proposition: true,
        lastSeenAt: true,
        importanceScore: true,
        topicId: true,
        topic: { select: { id: true, slug: true, name: true } },
        candidates: {
          where: { summary: { status: { in: ['candidate', 'pending_review', 'published'] } } },
          orderBy: { relevanceScore: 'desc' },
          take: 5,
          select: { summaryId: true },
        },
      },
    }),
    prisma.userBookmark.findMany({
      // 收藏的标题不在 user_bookmarks 表中；先按用户取一个有界集合，
      // 再用已解析的目标标题/正文过滤，避免用户只能按收藏备注找到资料。
      where: { userId: u.id },
      orderBy: { createdAt: 'desc' },
      take: 24,
      select: { id: true, note: true, targetType: true, targetId: true, createdAt: true },
    }),
  ]);

  const bookmarkedSummaryIds = bookmarks
    .filter((bookmark) => bookmark.targetType === 'radar_candidate' || bookmark.targetType === 'summary')
    .map((bookmark) => bookmark.targetId);
  const bookmarkedResearchIds = bookmarks
    .filter((bookmark) => bookmark.targetType === 'research' || bookmark.targetType === 'knowledge')
    .map((bookmark) => bookmark.targetId);
  const [bookmarkedSummaries, bookmarkedResearches] = await Promise.all([
    bookmarkedSummaryIds.length > 0
      ? prisma.summary.findMany({
          where: { id: { in: bookmarkedSummaryIds }, status: { in: ['candidate', 'pending_review', 'published'] } },
          select: { id: true, title: true, body: true, interpretation: true, url: true },
        })
      : [],
    bookmarkedResearchIds.length > 0
      ? prisma.research.findMany({
          where: {
            id: { in: bookmarkedResearchIds },
            OR: [{ status: 'published' }, { authorId: u.id, status: 'draft' }],
            ...(manualSearch ? {} : { AND: [{ OR: [
              { type: 'research' as const },
              { type: 'knowledge' as const, knowledgeIndexText: { not: null } },
            ] }] }),
          },
          select: { id: true, title: true, type: true, knowledgeIndexText: true, body: true, background: true, conclusion: true, authorId: true, status: true, updatedAt: true },
        })
      : [],
  ]);

  const semanticItems = await semanticPromise;
  const localItems = personalItems.map((item) => ({
    ...item,
    ...(semanticItems.some((semantic) => semantic.id === item.id) ? { semanticMatch: true } : {}),
  }));
  const items: Array<RowBase & { kind: string }> = [
    ...localItems.filter((item) => item.confirmedKnowledge),
    ...semanticItems,
    ...localItems.filter((item) => !item.confirmedKnowledge),
    ...issues.map((issue) => ({
      kind: 'issue' as const,
      id: issue.id,
      title: issue.title,
      snippet: issue.proposition.slice(0, 240),
      sourceRefs: issue.candidates.map((candidate) => ({
        type: 'summary' as const,
        value: candidate.summaryId,
        required: false as const,
      })),
      updatedAt: issue.lastSeenAt?.toISOString() ?? null,
      status: 'active',
      topicMatch: issue.topicId === topicParam,
    })),
    ...bookmarks.flatMap((bookmark) => {
      const isSummary = bookmark.targetType === 'radar_candidate' || bookmark.targetType === 'summary';
      const target = isSummary
        ? bookmarkedSummaries.find((item) => item.id === bookmark.targetId)
        : bookmarkedResearches.find((item) => item.id === bookmark.targetId);
      if (!target) return [];
      // The two target selects intentionally have different shapes. Narrow
      // before reading their content fields so a bookmark remains a real
      // source rather than a loosely typed label.
      const targetTitle = target.title;
      const targetSnippet = isSummary
        ? ((target as (typeof bookmarkedSummaries)[number]).interpretation ?? target.body) || ''
        : ((target as (typeof bookmarkedResearches)[number]).background
          ?? (target as (typeof bookmarkedResearches)[number]).conclusion
          ?? target.body) || '';
      if (!personalContextTextScore(keywords, { title: targetTitle, body: `${bookmark.note ?? ''} ${targetSnippet}` })) return [];
      const researchTarget = isSummary ? undefined : target as (typeof bookmarkedResearches)[number];
      return [{
        kind: 'bookmark' as const,
        id: bookmark.id,
        title: targetTitle,
        snippet: (bookmark.note?.trim() || targetSnippet).slice(0, 240),
        private: researchTarget ? researchTarget.status !== 'published' : false,
        isExcerpt: researchTarget?.type === 'knowledge' && researchTarget.knowledgeIndexText === null,
        status: researchTarget?.status,
        sourceRefs: [{
          type: isSummary ? 'summary' as const : 'research' as const,
          value: target.id,
          required: false as const,
        }],
        updatedAt: researchTarget?.updatedAt.toISOString() ?? bookmark.createdAt.toISOString(),
      }];
    }),
  ];

  const topics = Array.from(
    new Map(
      issues.map((issue) => [issue.topic.id, issue.topic] as const),
    ).values(),
  ).slice(0, 5);

  const seenItemKeys = new Set<string>();
  const uniqueItems = items.filter((item) => {
    const key = `${item.kind === 'knowledge' ? 'research' : item.kind}:${item.id}`;
    if (seenItemKeys.has(key)) return false;
    seenItemKeys.add(key);
    return true;
  });

  if (topicParam && topics.length === 0) {
    const topic = await prisma.topic.findUnique({
      where: { id: topicParam },
      select: { id: true, slug: true, name: true, enabled: true },
    });
    if (topic?.enabled) topics.push({ id: topic.id, slug: topic.slug, name: topic.name });
  }

  return NextResponse.json({ items: uniqueItems.slice(0, PERSONAL_CONTEXT_LIMITS.results), topics });
});

async function findSemanticKnowledge(
  query: string,
  userId: string,
  requestId: string,
): Promise<Array<RowBase & { kind: 'knowledge'; private: true; semanticMatch: true; sourceRefs: ContextSourceRef[] }>> {
  const env = getWebEnv();
  if (!env.INTERNAL_SERVICE_TOKEN) return [];
  try {
    const result = await fetchAiEngine<{ ids?: unknown }>({
      url: `${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/knowledge-index/search`,
      requestId,
      method: 'POST',
      retry: false,
      timeoutMs: 2_200,
      headers: { 'x-internal-token': env.INTERNAL_SERVICE_TOKEN },
      context: 'ai-research.context.semantic-knowledge',
      body: { userId, query, limit: 4 },
    });
    if (!result.ok || !Array.isArray(result.body.ids)) return [];
    const ids = Array.from(new Set(result.body.ids.filter(
      (id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/iu.test(id),
    ))).slice(0, 4);
    if (!ids.length) return [];

    const rows = await prisma.research.findMany({
      where: {
        id: { in: ids },
        authorId: userId,
        type: 'knowledge',
        status: 'draft',
        knowledgeIndexText: { not: null },
      },
      select: { id: true, title: true, knowledgeIndexText: true, updatedAt: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      return [{
        kind: 'knowledge' as const,
        id: row.id,
        title: row.title,
        snippet: (row.knowledgeIndexText ?? '').slice(0, 240),
        private: true as const,
        semanticMatch: true as const,
        confirmedKnowledge: true,
        status: 'draft',
        sourceRefs: [{ type: 'research' as const, value: row.id, required: false as const }],
        updatedAt: row.updatedAt.toISOString(),
      }];
    });
  } catch {
    return [];
  }
}
