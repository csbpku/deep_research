// BFF handler: GET /api/topics/[slug] — 主题详情（候选 + 综述 + 关注状态）。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { findTopicBySlugOrId } from '@/lib/topics';

export const GET = apiHandler<[NextRequest, { params: Promise<{ slug: string }> }]>(async (req, ctx) => {
  const { slug } = await ctx.params;
  if (!slug) return NextResponse.json({ code: 'NOT_FOUND', message: 'topic 不存在' }, { status: 404 });

  const user = await getCurrentUser();
  const topic = await findTopicBySlugOrId(slug, {
    id: true,
    slug: true,
    name: true,
    summary: true,
    tier: true,
    candidateCount: true,
    sourceCount: true,
    aggregationWindowStart: true,
    aggregationWindowEnd: true,
    lastSyncedAt: true,
    synthesisGeneratedAt: true,
    synthesisModel: true,
    synthesisVersion: true,
    synthesisPayload: true,
    synthesisErrorCode: true,
    synthesisErrorMessage: true,
  });
  if (!topic) return NextResponse.json({ code: 'NOT_FOUND', message: 'topic 不存在' }, { status: 404 });

  const [candidates, followed] = await Promise.all([
    prisma.topicCandidate.findMany({
      where: { topicId: topic.id },
      orderBy: { addedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        similarityScore: true,
        addedAt: true,
        addedReason: true,
        summary: {
          select: {
            id: true,
            title: true,
            url: true,
            canonicalUrl: true,
            originalKind: true,
            tags: true,
            interpretation: true,
            publishedAt: true,
            originalFetchedAt: true,
            createdAt: true,
          },
        },
      },
    }),
    user
      ? prisma.topicFollow.findUnique({ where: { userId_topicId: { userId: user.id, topicId: topic.id } } })
      : Promise.resolve(null),
  ]);

  return NextResponse.json({
    topic: {
      ...topic,
      aggregationWindowStart: topic.aggregationWindowStart.toISOString(),
      aggregationWindowEnd: topic.aggregationWindowEnd.toISOString(),
      lastSyncedAt: topic.lastSyncedAt?.toISOString() ?? null,
      synthesisGeneratedAt: topic.synthesisGeneratedAt?.toISOString() ?? null,
      followed: !!followed,
    },
    candidates: candidates.map((c) => ({
      id: c.id,
      similarityScore: c.similarityScore,
      addedAt: c.addedAt.toISOString(),
      addedReason: c.addedReason,
      summary: c.summary
        ? {
            ...c.summary,
            publishedAt: c.summary.publishedAt?.toISOString() ?? null,
            originalFetchedAt: c.summary.originalFetchedAt?.toISOString() ?? null,
            createdAt: c.summary.createdAt.toISOString(),
          }
        : null,
    })),
  });
});
