// BFF handler: GET /api/topics/[slug]/issues — 专题热点议题（ADR 0010）。
//
// 公开访问；登录用户能看到自己已关注但未查看的标记。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma, type TopicIssueStatus } from '@prisma/client';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { collapseTopicIssues, findTopicBySlugOrId } from '@/lib/topics';
import { recordProductEvent } from '@/lib/product-events';
import { TOPIC_ELIGIBILITY_SQL } from '@/lib/radar/topic-eligibility';

export const dynamic = 'force-dynamic';

type Sort = 'importance' | 'newest';

function parseSort(value: string | null): Sort {
  return value === 'newest' ? 'newest' : 'importance';
}

function parseStatus(value: string | null): TopicIssueStatus | 'all' {
  if (value === 'all') return 'all';
  if (value === 'resolved') return 'resolved';
  if (value === 'archived') return 'archived';
  return 'active';
}

function parseNonNegativeInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePageSize(value: string | null): number {
  const parsed = parseNonNegativeInt(value, 30);
  return Math.min(Math.max(parsed, 1), 50);
}

export const GET = apiHandler<[NextRequest, { params: Promise<{ slug: string }> }]>(async (req, ctx) => {
  const { slug } = await ctx.params;
  if (!slug) {
    return NextResponse.json({ code: 'NOT_FOUND', message: 'topic 不存在' }, { status: 404 });
  }

  const topic = await findTopicBySlugOrId(slug, { id: true, slug: true });
  if (!topic) {
    return NextResponse.json({ code: 'NOT_FOUND', message: 'topic 不存在' }, { status: 404 });
  }

  const url = new URL(req.url);
  const sort = parseSort(url.searchParams.get('sort'));
  const statusFilter = parseStatus(url.searchParams.get('status'));
  const offset = parseNonNegativeInt(url.searchParams.get('offset'), 0);
  const count = parsePageSize(url.searchParams.get('count'));

  const where: import('@prisma/client').Prisma.TopicIssueWhereInput = {
    topicId: topic.id,
    ...(statusFilter === 'all' ? {} : { status: statusFilter }),
  };

  const issueRowsRaw = await prisma.$transaction(async (tx) => {
    const eligible = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT DISTINCT s.id FROM topic_issue_candidates tic
      JOIN topic_issues ti ON ti.id = tic."issueId"
      JOIN summaries s ON s.id = tic."summaryId"
      WHERE ti."topicId" = ${topic.id}::uuid
        AND ${Prisma.raw(TOPIC_ELIGIBILITY_SQL)}
    `);
    const eligibleIds = eligible.map(row => row.id);
    return tx.topicIssue.findMany({
      where,
      orderBy:
        sort === 'newest'
          ? [{ lastSeenAt: 'desc' }, { id: 'asc' }]
          : [{ importanceScore: 'desc' }, { lastSeenAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        kind: true,
        status: true,
        title: true,
        proposition: true,
        summary: true,
        importanceScore: true,
        firstSeenAt: true,
        lastSeenAt: true,
        candidates: { where: { summaryId: { in: eligibleIds } }, select: { summaryId: true } },
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 });

  const publicIssues = collapseTopicIssues(
    issueRowsRaw.filter(issue => issue.candidates.length > 0).map((issue) => ({
      ...issue,
      candidateIds: issue.candidates.map((candidate) => candidate.summaryId),
    })),
  );
  const total = publicIssues.length;
  const issues = publicIssues.slice(offset, offset + count);

  const user = await getCurrentUser();
  let lastViewedAt: Date | null = null;
  if (user) {
    const follow = await prisma.topicFollow.findUnique({
      where: { userId_topicId: { userId: user.id, topicId: topic.id } },
      select: { lastViewedAt: true },
    });
    lastViewedAt = follow?.lastViewedAt ?? null;
  }

  // V2 闭环埋点：进入「热点议题」时记录一次（默认 1 分钟内自动 dedupe）
  if (user) {
    await recordProductEvent({
      userId: user.id,
      eventType: 'topic_issue_viewed',
      targetType: 'topic',
      targetId: topic.id,
      metadata: { slug: topic.slug, count: issues.length },
    }).catch(() => undefined);
  }

  return NextResponse.json({
    total,
    offset,
    count,
    issues: issues.map((issue) => ({
      id: issue.id,
      kind: issue.kind,
      status: issue.status,
      title: issue.title,
      proposition: issue.proposition,
      summary: issue.summary,
      importanceScore: issue.importanceScore,
      firstSeenAt: issue.firstSeenAt.toISOString(),
      lastSeenAt: issue.lastSeenAt.toISOString(),
      isUnread: lastViewedAt ? issue.lastSeenAt > lastViewedAt : true,
      candidates: issue.candidateIds.map((summaryId) => ({ summaryId })),
    })),
  });
});
