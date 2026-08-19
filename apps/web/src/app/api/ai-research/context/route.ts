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

  const likeFilter = query
    ? {
        OR: [
          { title: { contains: query, mode: 'insensitive' as const } },
          { proposition: { contains: query, mode: 'insensitive' as const } },
        ],
      }
    : {};

  const [researches, knowledge, issues, bookmarks] = await Promise.all([
    prisma.research.findMany({
      where: {
        status: 'published',
        ...likeFilter,
        OR: undefined,
        title: { contains: query, mode: 'insensitive' },
      },
      orderBy: { publishedAt: 'desc' },
      take: MAX_RESULTS,
      select: {
        id: true,
        title: true,
        body: true,
        background: true,
        conclusion: true,
        publishedAt: true,
      },
    }),
    prisma.research.findMany({
      where: {
        type: 'knowledge',
        status: 'published',
        title: { contains: query, mode: 'insensitive' },
      },
      orderBy: { publishedAt: 'desc' },
      take: 4,
      select: {
        id: true,
        title: true,
        body: true,
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
      },
    }),
    prisma.userBookmark.findMany({
      where: { userId: u.id, note: { contains: query, mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' },
      take: 4,
      select: { id: true, note: true, targetType: true, targetId: true, createdAt: true },
    }),
  ]);

  const items: Array<RowBase & { kind: string }> = [
    ...researches.slice(0, 6).map((r) => ({
      kind: 'research' as const,
      id: r.id,
      title: r.title,
      snippet: (r.background ?? r.conclusion ?? r.body ?? '').slice(0, 240),
      updatedAt: r.publishedAt?.toISOString() ?? null,
    })),
    ...knowledge.map((r) => ({
      kind: 'knowledge' as const,
      id: r.id,
      title: r.title,
      snippet: (r.body ?? '').slice(0, 240),
      updatedAt: r.publishedAt?.toISOString() ?? null,
    })),
    ...issues.map((issue) => ({
      kind: 'issue' as const,
      id: issue.id,
      title: issue.title,
      snippet: issue.proposition,
      updatedAt: null,
    })),
    ...bookmarks.map((b) => ({
      kind: 'bookmark' as const,
      id: b.id,
      title: b.note ?? `已收藏 ${b.targetType}`,
      snippet: `target: ${b.targetType}`,
      updatedAt: b.createdAt.toISOString(),
    })),
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
