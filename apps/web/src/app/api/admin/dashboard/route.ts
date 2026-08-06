// BFF handler: GET /api/admin/dashboard —— Admin 首页统计。
//
// Week 8 范围（mockup `page-admin`）：待审核数、本周新增、AI 调研、本月成本、
// 同步状态、失败 job 数。不做复杂图表（Phase 3b）。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../lib/db';
import { apiHandler } from '../../../../lib/api-handler';
import { requireAdmin } from '../../../../lib/auth/session';
import { withRequestId } from '../../../../lib/log';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const _requestId = withRequestId(req.headers);
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const [
    pendingShares,
    pendingCommentNominations,
    newResearchesThisWeek,
    aiJobsLast24h,
    failedAiJobsLast24h,
    failedImportJobs,
    monthAiCostCents,
    lastRadarSync,
  ] = await Promise.all([
    prisma.shareSubmission.count({ where: { status: 'pending' } }),
    prisma.comment.count({ where: { promoteStatus: 'nominated' } }),
    prisma.research.count({
      where: { status: 'published', publishedAt: { gte: sevenDaysAgo } },
    }),
    prisma.aiResearchJob.count({
      where: { createdAt: { gte: oneDayAgo } },
    }),
    prisma.aiResearchJob.count({
      where: { status: 'failed', createdAt: { gte: oneDayAgo } },
    }),
    prisma.contentImportJob.count({
      where: { status: 'failed' },
    }),
    prisma.aiResearchJob.aggregate({
      where: { createdAt: { gte: oneMonthAgo }, status: { in: ['succeeded', 'partial'] } },
      _sum: { costCents: true },
    }),
    prisma.radarSyncRun.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        completedAt: true,
        createdAt: true,
        source: { select: { name: true, sourceType: true } },
        errorCode: true,
      },
    }),
  ]);

  return NextResponse.json({
    // 待审核汇总
    pendingReviews: {
      total: pendingShares + pendingCommentNominations,
      shares: pendingShares,
      commentNominations: pendingCommentNominations,
    },
    // 内容产出
    content: {
      newResearchesThisWeek,
    },
    // AI 调研 / Job 健康
    jobs: {
      submittedLast24h: aiJobsLast24h,
      failedLast24h: failedAiJobsLast24h,
      failedImportJobs,
    },
    // 成本
    cost: {
      monthUsdCents: monthAiCostCents._sum.costCents ?? 0,
      // 简单显示：cents 转 dollars（保留精度）
      monthUsd: ((monthAiCostCents._sum.costCents ?? 0) / 100).toFixed(2),
    },
    // 雷达最近同步状态
    radar: {
      lastSync: lastRadarSync
        ? {
            id: lastRadarSync.id,
            source: lastRadarSync.source,
            status: lastRadarSync.status,
            completedAt: lastRadarSync.completedAt?.toISOString() ?? null,
            createdAt: lastRadarSync.createdAt.toISOString(),
            errorCode: lastRadarSync.errorCode,
          }
        : null,
    },
    generatedAt: now.toISOString(),
  });
});
