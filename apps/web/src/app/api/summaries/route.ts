// BFF handler: AI 雷达日报列表 / 单日查询。
//
// 新模式（替代旧的"每日期最多 4 条手工精选"）：
//   - 每天只有一条 published summary，canonicalUrl = digest://YYYY-MM-DD
//   - 文章内容放在 digestMeta（tldr / sections / highlights / ranked）
//   - ranked 条目带 radarUrl（/radar/{id}），点击回到雷达详情
//
// 入参: ?date=YYYY-MM-DD 返回单日日报；缺省返回最近 digest 列表。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../lib/db';
import { apiHandler } from '../../../lib/api-handler';
import { toApiErrorResponse } from '../../../lib/errors';
import { withRequestId } from '../../../lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { SUMMARY_STATUS } from '@deep-research/shared/states';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

const DigestQuery = z.object({
  date: z.string().regex(DATE_RE, 'date must be YYYY-MM-DD').optional(),
  limit: z.coerce.number().int().min(1).max(90).optional(),
});

interface DigestRankedItem {
  summaryId: string | null;
  title: string;
  url: string;
  radarUrl: string | null;
  oneLineReason: string;
}

interface DigestMeta {
  tldr?: string;
  sections?: Array<{ title: string; body: string }>;
  highlights?: string[];
  ranked?: DigestRankedItem[];
  sourcesUsed?: string[];
  candidateCount?: number;
  narrativeDegraded?: boolean;
  model?: string | null;
  generatedAt?: string | null;
}

interface DigestRow {
  id: string;
  title: string;
  publishedAt: Date | null;
  summaryDate: Date;
  digestMeta: unknown;
}

const DIGEST_SELECT = {
  id: true,
  title: true,
  publishedAt: true,
  summaryDate: true,
  digestMeta: true,
} as const;

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const url = new URL(req.url);
  const parsed = DigestQuery.safeParse({
    date: url.searchParams.get('date') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'date/limit 参数格式错误',
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { date: dateStr, limit = 30 } = parsed.data;

  if (dateStr) {
    const row = await prisma.summary.findFirst({
      where: {
        canonicalUrl: `digest://${dateStr}`,
        status: SUMMARY_STATUS.PUBLISHED,
      },
      select: DIGEST_SELECT,
    });
    if (!row || !row.digestMeta) {
      return toApiErrorResponse({
        code: ERROR_CODES.DRAFT_NOT_FOUND,
        message: '该日期暂无日报',
        requestId,
      });
    }
    return NextResponse.json({ date: dateStr, item: serializeDigest(row) });
  }

  const rows = await prisma.summary.findMany({
    where: {
      canonicalUrl: { startsWith: 'digest://' },
      status: SUMMARY_STATUS.PUBLISHED,
    },
    orderBy: [{ summaryDate: 'desc' }, { publishedAt: 'desc' }],
    take: limit,
    select: DIGEST_SELECT,
  });
  const dates = rows.filter((row) => row.digestMeta !== null).map(serializeDigest);
  return NextResponse.json({ dates, total: dates.length });
});

function serializeDigest(row: DigestRow) {
  const meta = (row.digestMeta ?? {}) as DigestMeta;
  return {
    summaryId: row.id,
    date: row.summaryDate.toISOString().slice(0, 10),
    title: row.title,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    tldr: meta.tldr ?? '',
    sections: meta.sections ?? [],
    highlights: meta.highlights ?? [],
    ranked: meta.ranked ?? [],
    sourcesUsed: meta.sourcesUsed ?? [],
    candidateCount: meta.candidateCount ?? 0,
    narrativeDegraded: Boolean(meta.narrativeDegraded),
    model: meta.model ?? null,
    generatedAt: meta.generatedAt ?? null,
  };
}
