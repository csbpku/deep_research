// BFF handler: GET /api/admin/dashboard —— Admin 首页统计。
//
// Admin 首页统计 + 雷达实时监控聚合。

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
  const shanghaiParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const shanghaiPart = (type: Intl.DateTimeFormatPartTypes) =>
    shanghaiParts.find((part) => part.type === type)?.value ?? '';
  const shanghaiDate = `${shanghaiPart('year')}-${shanghaiPart('month')}-${shanghaiPart('day')}`;
  const todayStart = new Date(`${shanghaiDate}T00:00:00+08:00`);
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 3600 * 1000);

  const [
    pendingShares,
    pendingCommentNominations,
    newResearchesThisWeek,
    aiJobsLast24h,
    failedAiJobsLast24h,
    failedImportJobs,
    monthAiCostCents,
    lastRadarSync,
    todayRadarRuns,
    todayRadarCandidates,
    todayFilteredDiagnostics,
    todayFailedDiagnostics,
    todayRadarAccepted,
    stuckRadarSources,
    // ADR 0010: 认知闭环 V2 关键产品事件计数
    topicResearchStarted7d,
    researchPlanConfirmed7d,
    researchContextReused7d,
    researchDraftOpened7d,
    researchReopenedFromTopic7d,
    topicIssueViewed7d,
    topicViewedWithUnread7d,
    topicFollowed7d,
    topicUnfollowed7d,
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
    prisma.radarSyncRun.findMany({
      where: { createdAt: { gte: todayStart, lt: tomorrowStart } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        totalFetched: true,
        totalNew: true,
        totalSkipped: true,
        totalFailed: true,
        skippedExisting: true,
        skippedRuleNoise: true,
        skippedDistilledNoise: true,
        skippedConflict: true,
        errorCode: true,
        createdAt: true,
        completedAt: true,
        source: { select: { name: true, sourceType: true } },
      },
    }),
    prisma.summary.findMany({
      where: {
        source: 'daily',
        syncRunId: { not: null },
        createdAt: { gte: todayStart, lt: tomorrowStart },
      },
      select: { distilledTotal: true, distilledTier: true },
    }),
    prisma.radarSyncDiagnostic.findMany({
      where: {
        kind: 'filtered',
        createdAt: { gte: todayStart, lt: tomorrowStart },
      },
      distinct: ['canonicalUrl'],
      select: { canonicalUrl: true, reasonCode: true },
    }),
    prisma.radarSyncDiagnostic.findMany({
      where: {
        kind: 'failed',
        createdAt: { gte: todayStart, lt: tomorrowStart },
      },
      distinct: ['canonicalUrl'],
      select: { canonicalUrl: true, createdAt: true },
    }),
    prisma.summary.findMany({
      where: {
        source: 'daily',
        syncRunId: { not: null },
        updatedAt: { gte: todayStart, lt: tomorrowStart },
      },
      distinct: ['canonicalUrl'],
      select: { canonicalUrl: true, updatedAt: true },
    }),
    // P1.10: surface sources wedged into failure — consecutiveFailures ≥ 3.
    // Independent of the today's runs aggregation so the operator sees chronic
    // breakage even when today's runs haven't reported any failures yet.
    prisma.radarSource.findMany({
      where: { consecutiveFailures: { gte: 3 } } as Record<string, unknown>,
      orderBy: [
        { consecutiveFailures: 'desc' },
        { lastErrorAt: 'desc' },
      ] as unknown as never,
      select: {
        id: true,
        name: true,
        sourceType: true,
        consecutiveFailures: true,
        lastErrorCode: true,
        lastErrorMessage: true,
        lastErrorAt: true,
        lastSyncAt: true,
      } as unknown as never,
    }),
    // ADR 0010: 认知闭环 V2 关键产品事件计数
    prisma.productEvent.count({ where: { eventName: 'topic_research_started', occurredAt: { gte: sevenDaysAgo } } }),
    prisma.productEvent.count({ where: { eventName: 'research_plan_confirmed', occurredAt: { gte: sevenDaysAgo } } }),
    prisma.productEvent.count({ where: { eventName: 'research_context_reused', occurredAt: { gte: sevenDaysAgo } } }),
    prisma.productEvent.count({ where: { eventName: 'research_draft_opened', occurredAt: { gte: sevenDaysAgo } } }),
    prisma.productEvent.count({ where: { eventName: 'research_reopened_from_topic', occurredAt: { gte: sevenDaysAgo } } }),
    prisma.productEvent.count({ where: { eventName: 'topic_issue_viewed', occurredAt: { gte: sevenDaysAgo } } }),
    prisma.productEvent.count({ where: { eventName: 'topic_viewed_with_unread', occurredAt: { gte: sevenDaysAgo } } }),
    prisma.productEvent.count({ where: { eventName: 'topic_followed', occurredAt: { gte: sevenDaysAgo } } }),
    prisma.productEvent.count({ where: { eventName: 'topic_unfollowed', occurredAt: { gte: sevenDaysAgo } } }),
  ]);

  const radarRunSummary = todayRadarRuns.reduce(
    (summary, run) => {
      summary.total += 1;
      summary[run.status as 'running' | 'completed' | 'partial' | 'failed'] += 1;
      summary.fetched += run.totalFetched;
      summary.new += run.totalNew;
      summary.skipped += run.totalSkipped;
      summary.failed += run.totalFailed;
      summary.skipReasons.existing += run.skippedExisting;
      summary.skipReasons.ruleNoise += run.skippedRuleNoise;
      summary.skipReasons.distilledNoise += run.skippedDistilledNoise;
      summary.skipReasons.conflict += run.skippedConflict;
      if (run.errorCode) {
        const existing = summary.failures.find((item) => item.code === run.errorCode);
        if (existing) existing.count += Math.max(1, run.totalFailed);
        else summary.failures.push({
          code: run.errorCode,
          count: Math.max(1, run.totalFailed),
          sources: [run.source.name],
        });
      }
      return summary;
    },
    {
      total: 0,
      running: 0,
      completed: 0,
      partial: 0,
      failed: 0,
      fetched: 0,
      new: 0,
      skipped: 0,
      failedItems: 0,
      skipReasons: { existing: 0, ruleNoise: 0, distilledNoise: 0, unassessable: 0, hardVeto: 0, contentFetchFailed: 0, conflict: 0, other: 0 },
      failures: [] as Array<{ code: string; count: number; sources: string[] }>,
    },
  );
  // The sync table shows the latest run for each source. Use the same scope
  // for fetched/skipped in the monitor; dailyNew remains the all-runs total.
  const latestSourceRunsForTotals = new Map<string, (typeof todayRadarRuns)[number]>();
  for (const run of todayRadarRuns) {
    if (!latestSourceRunsForTotals.has(run.source.name)) {
      latestSourceRunsForTotals.set(run.source.name, run);
    }
  }
  radarRunSummary.fetched = [...latestSourceRunsForTotals.values()]
    .reduce((sum, run) => sum + run.totalFetched, 0);
  radarRunSummary.skipped = [...latestSourceRunsForTotals.values()]
    .reduce((sum, run) => sum + run.totalSkipped, 0);
  radarRunSummary.failedItems = todayRadarRuns.reduce((sum, run) => sum + run.totalFailed, 0);
  radarRunSummary.skipReasons.other = Math.max(
    0,
    radarRunSummary.skipped
      - radarRunSummary.skipReasons.existing
      - radarRunSummary.skipReasons.ruleNoise
      - radarRunSummary.skipReasons.distilledNoise
      - radarRunSummary.skipReasons.conflict,
  );

  const readingLevels = { collection: 0, deep_read: 0, skim: 0, noise: 0, pending: 0 };
  const scoreDistribution = [
    { label: '0–39', min: 0, max: 39, count: 0 },
    { label: '40–59', min: 40, max: 59, count: 0 },
    { label: '60–79', min: 60, max: 79, count: 0 },
    { label: '80–100', min: 80, max: 100, count: 0 },
  ];
  for (const candidate of todayRadarCandidates) {
    if (candidate.distilledTier === 'collection') readingLevels.collection += 1;
    else if (candidate.distilledTier === 'deep_read') readingLevels.deep_read += 1;
    else if (candidate.distilledTier === 'skim') readingLevels.skim += 1;
    else if (candidate.distilledTier === 'noise') readingLevels.noise += 1;
    else readingLevels.pending += 1;
    if (typeof candidate.distilledTotal === 'number') {
      const bucket = scoreDistribution.find(
        (item) => candidate.distilledTotal! >= item.min
          && (item.max === 100 ? candidate.distilledTotal! <= 100 : candidate.distilledTotal! < item.max + 1),
      );
      if (bucket) bucket.count += 1;
    }
  }
  const visibleToday = todayRadarCandidates.filter((candidate) =>
    candidate.distilledTier === 'collection'
    || candidate.distilledTier === 'deep_read'
    || candidate.distilledTier === 'skim',
  ).length;
  const todayGovernanceNoise = todayFilteredDiagnostics.filter(
    (item) => ['DISTILLED_NOISE', 'DISTILLED_UNASSESSABLE', 'DISTILLED_HARD_VETO'].includes(item.reasonCode),
  ).length;
  const governanceSkipReasons = todayFilteredDiagnostics.reduce(
    (counts, item) => {
      if (item.reasonCode === 'RULE_NOISE') counts.ruleNoise += 1;
      else if (item.reasonCode === 'DISTILLED_NOISE') counts.distilledNoise += 1;
      else if (item.reasonCode === 'DISTILLED_UNASSESSABLE') counts.unassessable += 1;
      else if (item.reasonCode === 'DISTILLED_HARD_VETO') counts.hardVeto += 1;
      else if (item.reasonCode === 'CONTENT_FETCH_FAILED') counts.contentFetchFailed += 1;
      else if (item.reasonCode === 'LOW_QUALITY') counts.lowQuality += 1;
      else if (item.reasonCode === 'PENDING_SCORE') counts.pendingScore += 1;
      else counts.other += 1;
      return counts;
    },
    { ruleNoise: 0, distilledNoise: 0, unassessable: 0, hardVeto: 0, contentFetchFailed: 0, lowQuality: 0, pendingScore: 0, other: 0 },
  );
  const acceptedCanonicalUrls = new Set(todayRadarAccepted.map((item) => item.canonicalUrl));
  const failedCanonicalUrls = new Set(todayFailedDiagnostics.map((item) => item.canonicalUrl));
  const filteredCanonicalUrls = new Set(todayFilteredDiagnostics.map((item) => item.canonicalUrl));
  const attemptedCanonicalUrls = new Set([
    ...acceptedCanonicalUrls,
    ...failedCanonicalUrls,
    ...filteredCanonicalUrls,
  ]);
  const acceptedAt = new Map<string, number>();
  for (const item of todayRadarAccepted) {
    acceptedAt.set(item.canonicalUrl, Math.max(acceptedAt.get(item.canonicalUrl) ?? 0, item.updatedAt.getTime()));
  }
  const unresolvedFailedCount = [...failedCanonicalUrls]
    .filter((canonicalUrl) => {
      const latestFailedAt = todayFailedDiagnostics
        .filter((item) => item.canonicalUrl === canonicalUrl)
        .reduce((latest, item) => Math.max(latest, item.createdAt.getTime()), 0);
      return (acceptedAt.get(canonicalUrl) ?? 0) <= latestFailedAt;
    }).length;
  const failureRate = attemptedCanonicalUrls.size > 0
    ? unresolvedFailedCount / attemptedCanonicalUrls.size
    : 0;
  radarRunSummary.failures.sort((a, b) => b.count - a.count);
  const latestSourceRuns = new Map<string, (typeof todayRadarRuns)[number]>();
  for (const run of todayRadarRuns) {
    if (!latestSourceRuns.has(run.source.name)) latestSourceRuns.set(run.source.name, run);
  }
  const latestSourceStatus = [...latestSourceRuns.values()].reduce(
    (summary, run) => {
      summary.total += 1;
      summary[run.status as 'running' | 'completed' | 'partial' | 'failed'] += 1;
      return summary;
    },
    { total: 0, running: 0, completed: 0, partial: 0, failed: 0 },
  );

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
    // ADR 0010: 认知闭环 V2 — 关键产品事件计数（最近 7 天）
    cognitionLoop: {
      topicResearchStarted: topicResearchStarted7d,
      researchPlanConfirmed: researchPlanConfirmed7d,
      researchContextReused: researchContextReused7d,
      researchDraftOpened: researchDraftOpened7d,
      researchReopenedFromTopic: researchReopenedFromTopic7d,
      topicIssueViewed: topicIssueViewed7d,
      topicViewedWithUnread: topicViewedWithUnread7d,
      topicFollowed: topicFollowed7d,
      topicUnfollowed: topicUnfollowed7d,
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
      // P1.10: chronic failure surface — sources stuck failing N+ times.
      // Sorted descending by consecutiveFailures so the operator sees the
      // worst offenders first; the cap of 3 consecutive failures matches
      // the convention agreed with ops to alert but not panic.
      stuckSources: (stuckRadarSources as unknown as Array<{
        id: string;
        name: string;
        sourceType: string;
        consecutiveFailures: number;
        lastErrorCode: string | null;
        lastErrorMessage: string | null;
        lastErrorAt: Date | null;
        lastSyncAt: Date | null;
      }>).map((source) => ({
        id: source.id,
        name: source.name,
        sourceType: source.sourceType,
        consecutiveFailures: source.consecutiveFailures,
        lastErrorCode: source.lastErrorCode,
        lastErrorMessage: source.lastErrorMessage,
        lastErrorAt: source.lastErrorAt?.toISOString() ?? null,
        lastSyncAt: source.lastSyncAt?.toISOString() ?? null,
      })),
      monitor: {
        date: shanghaiDate,
        visibleToday,
        // A transient failure that was later accepted under the same
        // canonicalUrl is recovered, not an outstanding failed candidate.
        failedUniqueItems: unresolvedFailedCount,
        failureRate: {
          failed: unresolvedFailedCount,
          attempted: attemptedCanonicalUrls.size,
          percent: Number((failureRate * 100).toFixed(2)),
          targetPercent: 1,
          withinTarget: failureRate < 0.01,
        },
        active: radarRunSummary.running > 0,
        runs: radarRunSummary,
        latest: latestSourceStatus,
        readingLevels,
        scoreDistribution,
        governance: { noise: todayGovernanceNoise, skipReasons: governanceSkipReasons },
        activeSources: todayRadarRuns
          .filter((run) => run.status === 'running')
          .map((run) => ({
            name: run.source.name,
            sourceType: run.source.sourceType,
            startedAt: run.createdAt.toISOString(),
          })),
      },
    },
    generatedAt: now.toISOString(),
  });
});
