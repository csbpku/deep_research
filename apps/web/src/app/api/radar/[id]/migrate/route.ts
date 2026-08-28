// 雷达详情访问时的渐进迁移入口。
//
// 只负责判断是否需要迁移并投递任务，不在 Web 请求里执行 LLM 或正文抓取。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { getWebEnv } from '@/lib/env';
import { prisma } from '@/lib/db';
import { withRequestId } from '@/lib/log';
import { RadarIdParam } from '@/lib/schemas';

const MIGRATION_TAG = 'migration_queued_v2';
const ENRICHMENT_VERSION = '2.0';

function isIncompleteContent(content: string | null | undefined): boolean {
  const value = String(content ?? '').trim();
  if (value.length < 200) return true;
  const lowered = value.toLowerCase();
  return [
    'just a moment',
    'enable javascript and cookies',
    'prove your humanity',
    'complete the challenge',
    'checking your browser',
    'challenge-platform',
  ].some((marker) => lowered.includes(marker));
}

function isArxivSourceUrl(url: string | null | undefined): boolean {
  const value = String(url ?? '').trim().toLowerCase();
  return /(?:arxiv\.org\/(?:abs|html|pdf)\/|huggingface\.co\/papers\/)[^/?#\s]+/u.test(value);
}

function isRepoActivityDigestUrl(url: string | null | undefined): boolean {
  try {
    return new URL(String(url ?? '').trim()).searchParams.has('digest');
  } catch {
    return false;
  }
}

function needsMigration(summary: {
  tags: string[];
  distilledTier: string | null;
  originalKind: string | null;
  url: string | null;
  canonicalUrl: string;
  originalMarkdown: string | null;
  body: string;
  originalMeta: unknown;
  highlights: unknown;
}): boolean {
  if (summary.tags.includes(MIGRATION_TAG)) return false;
  if (
    summary.originalKind === 'github_repo'
    && isRepoActivityDigestUrl(summary.canonicalUrl)
  ) {
    return false;
  }

  // Older radar rows were ingested before HF Daily Papers/arXiv URLs were
  // classified. Correct the discriminator even when their old enrichment is
  // otherwise complete; otherwise the detail page keeps rendering them as a
  // generic web share forever.
  if (
    summary.originalKind !== 'arxiv'
    && isArxivSourceUrl(summary.url)
    && isArxivSourceUrl(summary.canonicalUrl)
  ) {
    return true;
  }
  if (summary.tags.includes('content_pending') || isIncompleteContent(summary.originalMarkdown ?? summary.body)) {
    return true;
  }

  const meta = summary.originalMeta && typeof summary.originalMeta === 'object'
    ? summary.originalMeta as { enrichmentVersion?: unknown; zread?: unknown }
    : null;
  const versionCurrent = meta?.enrichmentVersion === ENRICHMENT_VERSION;
  const isHighValue = summary.distilledTier === 'collection' || summary.distilledTier === 'deep_read';
  if (!isHighValue && versionCurrent) return false;
  if (!meta) return true;
  if (summary.originalKind === 'github_repo') {
    const zread = meta.zread;
    const zreadRecord = zread && typeof zread === 'object'
      ? zread as { status?: unknown; pages?: unknown }
      : null;
    const zreadReady = Boolean(
      zreadRecord
      && (zreadRecord.status === 'complete' || zreadRecord.status === 'partial')
      && Array.isArray(zreadRecord.pages)
      && zreadRecord.pages.length > 0,
    );
    return !versionCurrent || !zreadReady;
  }
  if (summary.originalKind === 'rss' || summary.originalKind === 'web_share') {
    return !versionCurrent || !summary.highlights;
  }
  return !versionCurrent;
}

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const parsed = RadarIdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return NextResponse.json({ queued: false, requestId }, { status: 400 });
  }

  const summary = await prisma.summary.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      source: true,
      syncRunId: true,
      shareSource: { select: { status: true } },
      tags: true,
      distilledTier: true,
      originalKind: true,
      url: true,
      canonicalUrl: true,
      originalMarkdown: true,
      body: true,
      originalMeta: true,
      highlights: true,
    },
  });
  const isRadar = summary && (
    (summary.source === 'daily' && summary.syncRunId !== null)
    || (summary.source === 'user' && summary.shareSource?.status === 'approved')
  );
  if (!summary || !isRadar || !needsMigration(summary)) {
    return NextResponse.json({ queued: false, requestId });
  }

  const claimed = await prisma.summary.updateMany({
    where: { id: summary.id, NOT: { tags: { has: MIGRATION_TAG } } },
    data: { tags: { push: MIGRATION_TAG } },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ queued: false, requestId });
  }

  const shouldPromoteToArxiv = summary.originalKind !== 'arxiv'
    && isArxivSourceUrl(summary.url)
    && isArxivSourceUrl(summary.canonicalUrl);
  if (shouldPromoteToArxiv) {
    await prisma.summary.update({
      where: { id: summary.id },
      data: { originalKind: 'arxiv' },
    });
  }

  const env = getWebEnv();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-request-id': requestId,
  };
  if (env.INTERNAL_SERVICE_TOKEN) headers['x-internal-token'] = env.INTERNAL_SERVICE_TOKEN;
  try {
    const upstream = await fetch(`${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/radar/enrich`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ summaryIds: [summary.id], force: true }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!upstream.ok) throw new Error(`migration_enqueue_${upstream.status}`);
  } catch {
    await prisma.summary.update({
      where: { id: summary.id },
      data: {
        tags: { set: summary.tags.filter((tag) => tag !== MIGRATION_TAG) },
        ...(shouldPromoteToArxiv ? { originalKind: summary.originalKind } : {}),
      },
    });
    return NextResponse.json({ queued: false, requestId }, { status: 503 });
  }
  return NextResponse.json({ queued: true, requestId }, { status: 202 });
});
