// BFF handler: GET /api/topics/[slug]/issues — 专题热点议题（ADR 0010）。
//
// 公开访问；登录用户能看到自己已关注但未查看的标记。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { TopicIssueStatus } from '@prisma/client';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { findTopicBySlugOrId } from '@/lib/topics';

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

export const GET = apiHandler<[NextRequest, { params: Promise<{ slug: string }> }]>(async (req, ctx) => {
  const { slug } = await ctx.params;
  if (!slug) {
    return NextResponse.json({ code: 'NOT_FOUND', message: 'topic 不存在' }, { status: 404 });
  }

  const topic = await findTopicBySlugOrId(slug, { id: true });
  if (!topic) {
    return NextResponse.json({ code: 'NOT_FOUND', message: 'topic 不存在' }, { status: 404 });
  }

  const url = new URL(req.url);
  const sort = parseSort(url.searchParams.get('sort'));
  const statusFilter = parseStatus(url.searchParams.get('status'));

  const where: import('@prisma/client').Prisma.TopicIssueWhereInput = {
    topicId: topic.id,
    ...(statusFilter === 'all' ? {} : { status: statusFilter }),
  };

  const issues = await prisma.topicIssue.findMany({
    where,
    orderBy:
      sort === 'newest'
        ? [{ lastSeenAt: 'desc' }]
        : [{ importanceScore: 'desc' }, { lastSeenAt: 'desc' }],
    take: 30,
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
      candidates: {
        select: {
          summaryId: true,
          relevanceScore: true,
          addedAt: true,
        },
        take: 8,
      },
    },
  });

  const user = await getCurrentUser();
  let lastViewedAt: Date | null = null;
  if (user) {
    const follow = await prisma.topicFollow.findUnique({
      where: { userId_topicId: { userId: user.id, topicId: topic.id } },
      select: { lastViewedAt: true },
    });
    lastViewedAt = follow?.lastViewedAt ?? null;
  }

  return NextResponse.json({
    issues: issues.map((issue) => ({
      ...issue,
      firstSeenAt: issue.firstSeenAt.toISOString(),
      lastSeenAt: issue.lastSeenAt.toISOString(),
      isUnread: lastViewedAt ? issue.lastSeenAt > lastViewedAt : true,
      candidates: issue.candidates.map((c) => ({
        ...c,
        addedAt: c.addedAt.toISOString(),
      })),
    })),
  });
});
