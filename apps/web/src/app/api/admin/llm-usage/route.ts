import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { requireAdmin } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { withRequestId } from '@/lib/log';

const MAX_LIMIT = 200;

function parsedPositiveInt(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const requestId = withRequestId(req.headers);
  const url = new URL(req.url);
  const days = parsedPositiveInt(url.searchParams.get('days'), 7, 90);
  const limit = parsedPositiveInt(url.searchParams.get('limit'), 100, MAX_LIMIT);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const where = { createdAt: { gte: since } };

  const [items, aggregates, trendItems] = await Promise.all([
    prisma.llmUsageEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        operation: true,
        provider: true,
        requestedModel: true,
        actualModel: true,
        fallbackModel: true,
        usedFallback: true,
        status: true,
        errorKind: true,
        inputTokens: true,
        outputTokens: true,
        costCents: true,
        latencyMs: true,
        createdAt: true,
      },
    }),
    prisma.llmUsageEvent.aggregate({
      where,
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, costCents: true },
    }),
    prisma.llmUsageEvent.findMany({
      where,
      select: {
        operation: true,
        requestedModel: true,
        status: true,
        usedFallback: true,
        errorKind: true,
        inputTokens: true,
        outputTokens: true,
        costCents: true,
        createdAt: true,
      },
    }),
  ]);

  const fallbackCount = await prisma.llmUsageEvent.count({
    where: { ...where, usedFallback: true },
  });
  const failureCount = await prisma.llmUsageEvent.count({
    where: { ...where, status: 'failed' },
  });

  const modelMap = new Map<string, {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    fallbackCount: number;
    failureCount: number;
  }>();
  const operationMap = new Map<string, {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    fallbackCount: number;
    failureCount: number;
  }>();
  const failureMap = new Map<string, { count: number; operations: Set<string> }>();
  const dayMap = new Map<string, {
    calls: number;
    totalTokens: number;
    fallbackCount: number;
    failureCount: number;
    knownCostCents: number;
  }>();
  const dayFormatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  for (const item of trendItems) {
    const operation = operationMap.get(item.operation) ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      fallbackCount: 0,
      failureCount: 0,
    };
    operation.calls += 1;
    operation.inputTokens += item.inputTokens ?? 0;
    operation.outputTokens += item.outputTokens ?? 0;
    if (item.usedFallback) operation.fallbackCount += 1;
    if (item.status === 'failed') {
      operation.failureCount += 1;
      const kind = item.errorKind ?? 'unknown';
      const failure = failureMap.get(kind) ?? { count: 0, operations: new Set<string>() };
      failure.count += 1;
      failure.operations.add(item.operation);
      failureMap.set(kind, failure);
    }
    operationMap.set(item.operation, operation);

    const model = modelMap.get(item.requestedModel) ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      fallbackCount: 0,
      failureCount: 0,
    };
    model.calls += 1;
    model.inputTokens += item.inputTokens ?? 0;
    model.outputTokens += item.outputTokens ?? 0;
    if (item.usedFallback) model.fallbackCount += 1;
    if (item.status === 'failed') model.failureCount += 1;
    modelMap.set(item.requestedModel, model);

    const dayKey = dayFormatter.format(item.createdAt);
    const day = dayMap.get(dayKey) ?? {
      calls: 0,
      totalTokens: 0,
      fallbackCount: 0,
      failureCount: 0,
      knownCostCents: 0,
    };
    day.calls += 1;
    day.totalTokens += (item.inputTokens ?? 0) + (item.outputTokens ?? 0);
    if (item.usedFallback) day.fallbackCount += 1;
    if (item.status === 'failed') day.failureCount += 1;
    day.knownCostCents += item.costCents ?? 0;
    dayMap.set(dayKey, day);
  }

  const modelBreakdown = [...modelMap.entries()]
    .map(([model, value]) => ({ model, totalTokens: value.inputTokens + value.outputTokens, ...value }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const operationBreakdown = [...operationMap.entries()]
    .map(([operation, value]) => ({ operation, totalTokens: value.inputTokens + value.outputTokens, ...value }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const daily = [...dayMap.entries()]
    .map(([date, value]) => ({ date, ...value }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const failureBreakdown = [...failureMap.entries()]
    .map(([kind, value]) => ({
      kind,
      count: value.count,
      operations: [...value.operations].sort(),
    }))
    .sort((a, b) => b.count - a.count);

  return NextResponse.json({
    days,
    generatedAt: new Date().toISOString(),
    summary: {
      calls: aggregates._count._all,
      inputTokens: aggregates._sum.inputTokens ?? 0,
      outputTokens: aggregates._sum.outputTokens ?? 0,
      knownCostCents: aggregates._sum.costCents ?? 0,
      fallbackCount,
      failureCount,
    },
    operationBreakdown,
    modelBreakdown,
    daily,
    failureBreakdown,
    items: items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
    requestId,
  });
});
