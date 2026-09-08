// Admin 雷达诊断列表：被过滤候选 + 候选处理失败记录。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma, type RadarDiagnosticKind, type RadarDiagnosticStatus } from '@prisma/client';

import { apiHandler } from '@/lib/api-handler';
import { requireAdmin } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { withRequestId } from '@/lib/log';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') === 'failed' ? 'failed' : 'filtered';
  const status = url.searchParams.get('status') ?? 'pending';
  const dateParam = url.searchParams.get('date') ?? 'today';
  const sourceType = url.searchParams.get('sourceType');
  const reasonCode = url.searchParams.get('reasonCode');
  const sort = url.searchParams.get('sort') ?? 'newest';
  const runId = url.searchParams.get('runId');
  const q = url.searchParams.get('q')?.trim();
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const rawPerPage = url.searchParams.get('per_page') ?? '50';
  const perPage = rawPerPage === 'all'
    ? 1000
    : Math.min(200, Math.max(1, Number(rawPerPage) || 50));

  const dateWhere: Prisma.RadarSyncDiagnosticWhereInput = {};
  let dateBounds: { gte: Date; lt: Date } | undefined;
  if (dateParam !== 'all') {
    const shanghaiParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const today = `${shanghaiParts.find((part) => part.type === 'year')?.value ?? ''}-${shanghaiParts.find((part) => part.type === 'month')?.value ?? ''}-${shanghaiParts.find((part) => part.type === 'day')?.value ?? ''}`;
    const selected = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : today;
    const start = new Date(`${selected}T00:00:00+08:00`);
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    dateBounds = { gte: start, lt: end };
    dateWhere.createdAt = dateBounds;
  }

  const where: Prisma.RadarSyncDiagnosticWhereInput = {
    kind: kind as RadarDiagnosticKind,
    ...(status !== 'all' ? { status: status as RadarDiagnosticStatus } : {}),
    ...(runId ? { runId } : {}),
    ...dateWhere,
    ...(sourceType ? { source: { sourceType: { startsWith: sourceType } } } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: 'insensitive' } },
            { body: { contains: q, mode: 'insensitive' } },
            { reasonMessage: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const distinctRows = await prisma.radarSyncDiagnostic.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      distinct: ['canonicalUrl'],
      select: {
        id: true,
        runId: true,
        sourceId: true,
        kind: true,
        status: true,
        title: true,
        url: true,
        canonicalUrl: true,
        body: true,
        originalKind: true,
        contentOrigin: true,
        publishedAt: true,
        tags: true,
        reasonCode: true,
        reasonMessage: true,
        errorType: true,
        errorDomain: true,
        distilledScore: true,
        distilledTier: true,
        promotedSummaryId: true,
        createdAt: true,
        source: { select: { name: true, sourceType: true } },
      },
    });

  // A failed candidate may be retried successfully later in the same day.
  // Keep the audit row, but do not count it as an unresolved failure.
  const canonicalUrls = distinctRows.map((item) => item.canonicalUrl);
  const recoveredRows = canonicalUrls.length > 0
    ? await prisma.summary.findMany({
        where: { canonicalUrl: { in: canonicalUrls } },
        select: { canonicalUrl: true, updatedAt: true },
      })
    : [];
  const recoveredAt = new Map<string, number>();
  for (const row of recoveredRows) {
    const timestamp = row.updatedAt.getTime();
    if (timestamp > (recoveredAt.get(row.canonicalUrl) ?? 0)) {
      recoveredAt.set(row.canonicalUrl, timestamp);
    }
  }
  const withRecovery = distinctRows.map((item) => ({
    ...item,
    resolved: item.kind === 'failed'
      && (recoveredAt.get(item.canonicalUrl) ?? 0) > item.createdAt.getTime(),
  }));
  const visibleRows = kind === 'failed' && status === 'pending'
    ? withRecovery.filter((item) => !item.resolved)
    : withRecovery;

  const [rateDiagnostics, rateAcceptedRows] = await Promise.all([
    prisma.radarSyncDiagnostic.findMany({
      where: dateWhere,
      select: { canonicalUrl: true, kind: true, createdAt: true },
    }),
    prisma.summary.findMany({
      where: {
        source: 'daily',
        syncRunId: { not: null },
        ...(dateBounds ? { updatedAt: dateBounds } : {}),
      },
      distinct: ['canonicalUrl'],
      select: { canonicalUrl: true, updatedAt: true },
    }),
  ]);
  const rateFailed = new Set(
    rateDiagnostics.filter((item) => item.kind === 'failed').map((item) => item.canonicalUrl),
  );
  const rateFiltered = new Set(
    rateDiagnostics.filter((item) => item.kind === 'filtered').map((item) => item.canonicalUrl),
  );
  const rateAccepted = new Set(rateAcceptedRows.map((item) => item.canonicalUrl));
  const attempted = new Set([...rateFailed, ...rateFiltered, ...rateAccepted]);
  const latestAcceptedAt = new Map<string, number>();
  for (const item of rateAcceptedRows) {
    latestAcceptedAt.set(item.canonicalUrl, Math.max(
      latestAcceptedAt.get(item.canonicalUrl) ?? 0,
      item.updatedAt.getTime(),
    ));
  }
  const unresolved = [...rateFailed].filter((canonicalUrl) => {
    const failedAt = rateDiagnostics
      .filter((item) => item.kind === 'failed' && item.canonicalUrl === canonicalUrl)
      .reduce((latest, item) => Math.max(latest, item.createdAt.getTime()), 0);
    return (latestAcceptedAt.get(canonicalUrl) ?? 0) <= failedAt;
  }).length;
  const percent = attempted.size > 0 ? (unresolved / attempted.size) * 100 : 0;

  const scoreOf = (item: (typeof visibleRows)[number]) => {
    const score = item.distilledScore;
    if (!score || typeof score !== 'object' || Array.isArray(score)) return -1;
    const value = (score as Record<string, unknown>).rankingScore
      ?? (score as Record<string, unknown>).effectiveTotal
      ?? (score as Record<string, unknown>).total;
    return typeof value === 'number' ? value : Number(value ?? -1);
  };
  const priorityOf = (item: (typeof visibleRows)[number]) => {
    if (item.kind === 'failed') return 0;
    return {
      AI_ENGINE_UNAVAILABLE: 1,
      CONTENT_FETCH_FAILED: 1,
      PENDING_SCORE: 2,
      DISTILLED_UNASSESSABLE: 3,
      LOW_QUALITY: 4,
      DISTILLED_HARD_VETO: 5,
      DISTILLED_NOISE: 6,
      RULE_NOISE: 7,
    }[item.reasonCode] ?? 8;
  };
  visibleRows.sort((a, b) => {
    if (sort === 'oldest') return a.createdAt.getTime() - b.createdAt.getTime();
    if (sort === 'source') return a.source.name.localeCompare(b.source.name) || b.createdAt.getTime() - a.createdAt.getTime();
    if (sort === 'reason') return a.reasonCode.localeCompare(b.reasonCode) || b.createdAt.getTime() - a.createdAt.getTime();
    if (sort === 'score') return scoreOf(b) - scoreOf(a) || b.createdAt.getTime() - a.createdAt.getTime();
    if (sort === 'priority') return priorityOf(a) - priorityOf(b) || scoreOf(b) - scoreOf(a) || b.createdAt.getTime() - a.createdAt.getTime();
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const total = visibleRows.length;
  const items = visibleRows.slice((page - 1) * perPage, page * perPage);

  return NextResponse.json({
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
    date: dateParam,
    failureRate: {
      failed: unresolved,
      attempted: attempted.size,
      percent: Number(percent.toFixed(2)),
      targetPercent: 1,
      withinTarget: percent < 1,
    },
    items,
    requestId,
  });
});
