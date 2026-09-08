// BFF handler: GET /api/ai-research/context — 自动上下文（ADR 0010）。
//
// 输入：?q=...&topic=...
// 输出：建议的历史研究、匹配议题、关联 Topic、用户收藏。
// 权限：仅返回公开 Research / Knowledge + 当前用户自己的私有草稿与收藏。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';

const MAX_RESULTS = 12;

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
  const query = (url.searchParams.get('q') ?? '').trim();
  if (query.length < 2) {
    return NextResponse.json({ items: [], topics: [] });
  }
  const topicParam = url.searchParams.get('topicId');

  const contentFilter = {
    OR: [
      { title: { contains: query, mode: 'insensitive' as const } },
      { body: { contains: query, mode: 'insensitive' as const } },
      { background: { contains: query, mode: 'insensitive' as const } },
      { conclusion: { contains: query, mode: 'insensitive' as const } },
    ],
  };

  const [researches, knowledge, issues, bookmarks] = await Promise.all([
    prisma.research.findMany({
      where: {
        type: 'research',
        AND: [contentFilter],
        OR: [{ status: 'published' }, { authorId: u.id }],
      },
      orderBy: { publishedAt: 'desc' },
      take: MAX_RESULTS,
      select: {
        id: true,
        title: true,
        status: true,
        body: true,
        background: true,
        conclusion: true,
        authorId: true,
        publishedAt: true,
      },
    }),
    prisma.research.findMany({
      where: {
        type: 'knowledge',
        AND: [contentFilter],
        OR: [{ status: 'published' }, { authorId: u.id }],
      },
      orderBy: { publishedAt: 'desc' },
      take: 4,
      select: {
        id: true,
        title: true,
        status: true,
        body: true,
        background: true,
        conclusion: true,
        authorId: true,
        publishedAt: true,
      },
    }),
    prisma.topicIssue.findMany({
      where: {
        status: 'active',
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { proposition: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: { importanceScore: 'desc' },
      take: 8,
      select: {
        id: true,
        title: true,
        proposition: true,
        importanceScore: true,
        topicId: true,
        topic: { select: { id: true, slug: true, name: true } },
        candidates: {
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
          where: { id: { in: bookmarkedSummaryIds } },
          select: { id: true, title: true, body: true, interpretation: true, url: true },
        })
      : [],
    bookmarkedResearchIds.length > 0
      ? prisma.research.findMany({
          where: {
            id: { in: bookmarkedResearchIds },
            OR: [{ status: 'published' }, { authorId: u.id }],
          },
          select: { id: true, title: true, body: true, background: true, conclusion: true },
        })
      : [],
  ]);

  const items: Array<RowBase & { kind: string }> = [
    ...researches.slice(0, 6).map((r) => ({
      kind: 'research' as const,
      id: r.id,
      title: r.title,
      snippet: (r.background ?? r.conclusion ?? r.body ?? '').slice(0, 240),
      private: r.authorId === u.id && r.status !== 'published',
      sourceRefs: [{ type: 'research' as const, value: r.id, required: false as const }],
      updatedAt: r.publishedAt?.toISOString() ?? null,
    })),
    ...knowledge.map((r) => ({
      kind: 'knowledge' as const,
      id: r.id,
      title: r.title,
      snippet: (r.body ?? '').slice(0, 240),
      private: r.authorId === u.id && r.status !== 'published',
      sourceRefs: [{ type: 'research' as const, value: r.id, required: false as const }],
      updatedAt: r.publishedAt?.toISOString() ?? null,
    })),
    ...issues.map((issue) => ({
      kind: 'issue' as const,
      id: issue.id,
      title: issue.title,
      snippet: issue.proposition,
      sourceRefs: issue.candidates.map((candidate) => ({
        type: 'summary' as const,
        value: candidate.summaryId,
        required: false as const,
      })),
      updatedAt: null,
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
      const haystack = `${bookmark.note ?? ''} ${targetTitle} ${targetSnippet}`.toLocaleLowerCase();
      if (!haystack.includes(query.toLocaleLowerCase())) return [];
      return [{
        kind: 'bookmark' as const,
        id: bookmark.id,
        title: targetTitle,
        snippet: bookmark.note?.trim() || targetSnippet.slice(0, 240),
        sourceRefs: [{
          type: isSummary ? 'summary' as const : 'research' as const,
          value: target.id,
          required: false as const,
        }],
        updatedAt: bookmark.createdAt.toISOString(),
      }];
    }),
  ];

  const topics = Array.from(
    new Map(
      issues
        .map((issue) => [issue.topic.id, issue.topic] as const)
        .concat(topicParam
          ? []
          : []),
    ).values(),
  ).slice(0, 5);

  if (topicParam && topics.length === 0) {
    const topic = await prisma.topic.findUnique({
      where: { id: topicParam },
      select: { id: true, slug: true, name: true },
    });
    if (topic) topics.push(topic);
  }

  return NextResponse.json({ items, topics });
});
