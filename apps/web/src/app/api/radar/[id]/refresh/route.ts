import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { getWebEnv } from '@/lib/env';
import { prisma } from '@/lib/db';
import { withRequestId } from '@/lib/log';
import { RadarIdParam } from '@/lib/schemas';

function isVisibleRadarSummary(summary: {
  source: string;
  syncRunId: string | null;
  shareSource: { status: string } | null;
}): boolean {
  return (
    (summary.source === 'daily' && summary.syncRunId !== null)
    || (summary.source === 'user' && summary.shareSource?.status === 'approved')
  );
}

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const parsed = RadarIdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return NextResponse.json({ message: 'id 必须为 UUID', requestId }, { status: 400 });
  }

  const summary = await prisma.summary.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      source: true,
      syncRunId: true,
      originalKind: true,
      shareSource: { select: { status: true } },
    },
  });
  if (!summary || !isVisibleRadarSummary(summary) || summary.originalKind !== 'github_repo') {
    return NextResponse.json({ message: '项目不存在或不支持刷新', requestId }, { status: 404 });
  }

  const env = getWebEnv();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-request-id': requestId,
  };
  if (env.INTERNAL_SERVICE_TOKEN) headers['x-internal-token'] = env.INTERNAL_SERVICE_TOKEN;

  let upstream: Response;
  try {
    upstream = await fetch(`${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/radar/enrich`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ summaryIds: [summary.id], force: true }),
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json(
      { message: '项目文档刷新失败：AI engine 当前不可达', requestId },
      { status: 503 },
    );
  }

  const payload = await upstream.json().catch(() => ({})) as {
    message?: string;
    detail?: { message?: string } | string;
  };
  if (!upstream.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail : payload.detail?.message;
    return NextResponse.json(
      { message: payload.message ?? detail ?? '项目文档刷新失败', requestId },
      { status: upstream.status >= 500 ? 502 : upstream.status },
    );
  }

  return NextResponse.json(
    { queued: true, summaryId: summary.id, requestId },
    { status: 202 },
  );
});
