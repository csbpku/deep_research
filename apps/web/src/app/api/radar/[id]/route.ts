// BFF handler: GET /api/radar/[id] — 雷达候选详情。
//
// 契约源：
//   - apps/web/prisma/schema.prisma: Summary（含 9 个雷达字段）
//   - docs/contracts/state-machines.md §4: SummaryStatus
//
// 入参: URL 段为 summary uuid（必须 syncRunId 非空 = 来自雷达）。
// 出参: 完整候选 + 反馈汇总 + 当前用户已选反馈 + canManage（admin 操作权限）。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../lib/db';
import { apiHandler } from '../../../../lib/api-handler';
import { requireUser } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';
import { RadarIdParam } from '../../../../lib/schemas';
import { aggregateFeedbacks, shapeCandidate } from '../../../../lib/radar/shape';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const GET = apiHandler<[NextRequest, { params: { id: string } }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const parsed = RadarIdParam.safeParse(ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const summary = await prisma.summary.findUnique({
    where: { id: parsed.data.id },
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
    },
  });

  if (!summary || summary.syncRunId === null || summary.source !== 'daily') {
    // 非雷达来源的 summary 不走详情页；返回 404 隐藏存在性
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '雷达候选不存在',
      requestId,
    });
  }

  const fbMap = await aggregateFeedbacks(prisma, [summary.id], u.id);
  const fb = fbMap.get(summary.id) ?? {
    counts: { useful: 0, inaccurate: 0, used: 0, favorite: 0, suggest_research: 0 },
    mine: [],
  };

  return NextResponse.json({
    ...shapeCandidate({
      summary,
      feedbackCounts: fb.counts,
      myFeedbacks: fb.mine,
      includeBody: true,
    }),
    canManage: u.role === 'admin',
  });
});