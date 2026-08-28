// BFF handler: GET /api/radar/[id] — 雷达候选详情。
//
// 契约源：
//   - apps/web/prisma/schema.prisma: Summary（含 9 个雷达字段）
//   - docs/contracts/state-machines.md §4: SummaryStatus
//
// 入参: URL 段为自动雷达 summary，或已审核用户分享生成的 summary。
// 出参: 完整候选 + 反馈汇总 + 当前用户已选反馈 + canManage（admin 操作权限）。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../lib/db';
import { apiHandler } from '../../../../lib/api-handler';
import { getCurrentUser } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';
import { RadarIdParam } from '../../../../lib/schemas';
import { aggregateFeedbacks, shapeCandidate } from '../../../../lib/radar/shape';
import { ERROR_CODES } from '@deep-research/shared/errors';

type SourceOutlineItem = { heading: string; level: number };

function sourceOutlineFromMarkdown(markdown: string | null, title: string): SourceOutlineItem[] {
  if (!markdown) return [];
  const result: SourceOutlineItem[] = [];
  let inFence = false;
  for (const line of markdown.replace(/\r\n?/gu, '\n').split('\n')) {
    if (/^\s*(```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^(#{2,6})\s+(.+?)\s*#*\s*$/u);
    if (!heading) continue;
    const label = heading[2]!
      .replace(/[*_`]/gu, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
      .trim();
    if (!label || label === title.trim() || result.some((item) => item.heading === label)) continue;
    result.push({ heading: label, level: heading[1]!.length });
  }
  return result.slice(0, 64);
}

function sourceOutlineFromSections(value: unknown, title: string): SourceOutlineItem[] {
  if (!Array.isArray(value)) return [];
  const result: SourceOutlineItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const heading = typeof raw.title === 'string' ? raw.title.trim() : '';
    const level = typeof raw.level === 'number' ? Math.max(2, Math.min(6, raw.level)) : 2;
    if (!heading || heading === title.trim() || result.some((entry) => entry.heading === heading)) continue;
    result.push({ heading, level });
  }
  return result.slice(0, 64);
}

function sourceOutlineFromRepoMeta(value: unknown): SourceOutlineItem[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const zread = (value as Record<string, unknown>).zread;
  if (!zread || typeof zread !== 'object' || Array.isArray(zread)) return [];
  const pages = (zread as Record<string, unknown>).pages;
  if (!Array.isArray(pages)) return [];
  const result: SourceOutlineItem[] = [];
  for (const page of pages) {
    if (!page || typeof page !== 'object' || Array.isArray(page)) continue;
    const heading = typeof (page as Record<string, unknown>).title === 'string'
      ? ((page as Record<string, unknown>).title as string).trim()
      : '';
    if (heading && !result.some((entry) => entry.heading === heading)) result.push({ heading, level: 2 });
  }
  return result.slice(0, 64);
}

function buildSourceOutline(summary: {
  title: string;
  originalKind?: string | null;
  originalMarkdown?: string | null;
  originalMeta?: unknown;
  sections?: unknown;
}): SourceOutlineItem[] {
  const fromSections = sourceOutlineFromSections(summary.sections, summary.title);
  if (fromSections.length) return fromSections;
  const fromRepo = summary.originalKind === 'github_repo'
    ? sourceOutlineFromRepoMeta(summary.originalMeta)
    : [];
  return fromRepo.length ? fromRepo : sourceOutlineFromMarkdown(summary.originalMarkdown ?? null, summary.title);
}

export const GET = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await getCurrentUser();

  const parsed = RadarIdParam.safeParse(await ctx.params);
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
      updatedAt: true,
      interpretation: true,
      scoreReason: true,
      scoreVersion: true,
      relevanceScore: true,
      timelinessScore: true,
      sourceQualityScore: true,
      distilledScore: true,
      distilledTier: true,
      selectionReason: true,
      sortOrder: true,
      syncRunId: true,
      source: true,
      shareSource: { select: { status: true } },
      // Deep-dive source content and enrichment payloads. originalKind
      // selects the presentation; originalMarkdown remains available to chat.
      originalKind: true,
      originalMarkdown: true,
      originalMeta: true,
      repoSummary: true,
      highlights: true,
      arxivAnalysis: true,
      // Phase 2B deep-dive: arxiv paper parsed structure.
      tldr: true,
      sections: true,
      figures: true,
      authors: true,
      sharedBy: { select: { id: true, name: true } },
      topicLinks: {
        select: {
          topic: { select: { id: true, slug: true, name: true, tier: true } },
        },
      },
      syncRun: {
        select: {
          id: true,
          completedAt: true,
          source: { select: { sourceType: true, name: true } },
        },
      },
    },
  });

  const isAutomaticRadar = summary?.source === 'daily' && summary.syncRunId !== null;
  const isApprovedShare = summary?.source === 'user' && summary.shareSource?.status === 'approved';
  if (!summary || (!isAutomaticRadar && !isApprovedShare)) {
    // 非雷达来源的 summary 不走详情页；返回 404 隐藏存在性
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '雷达候选不存在',
      requestId,
    });
  }

  const fbMap = await aggregateFeedbacks(prisma, [summary.id], u?.id);
  const fb = fbMap.get(summary.id) ?? {
    counts: { useful: 0, inaccurate: 0, used: 0, favorite: 0, suggest_research: 0 },
    mine: [],
  };

  const shaped = shapeCandidate({
    summary,
    feedbackCounts: fb.counts,
    myFeedbacks: fb.mine,
    includeBody: true,
  });
  const tier = summary.distilledTier ?? shaped.distilledScore?.tier ?? null;
  if ((tier === 'noise' || tier === null) && u?.role !== 'admin') {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '雷达候选不存在',
      requestId,
    });
  }

  // A skim is a summary surface by contract. Do not expose historical deep
  // enrichment or full source text even if old rows still contain it.
  const responseCandidate = tier === 'skim'
    ? {
        ...shaped,
        body: null,
        originalKind: null,
        originalMarkdown: null,
        originalMeta: null,
        githubItemMeta: null,
        repoSummary: null,
        highlights: null,
        arxivAnalysis: null,
        tldr: null,
        sections: null,
        figures: null,
        authors: [],
      }
    : shaped;

  return NextResponse.json({
    ...responseCandidate,
    sourceOutline: tier === 'skim' ? buildSourceOutline(summary) : null,
    canManage: u?.role === 'admin',
    isAuthenticated: Boolean(u),
  });
});
