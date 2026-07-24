// BFF handler: 每日摘要列表查询。
//
// 契约源：
//   - apps/web/prisma/schema.prisma: Summary（status / summaryDate / source 等）
//   - docs/contracts/state-machines.md §4: 只读 status='published' 摘要
//   - 架构 §四·Week 2: 指定日期最多 4 条精选；按 summaryDate 精确匹配
//
// W2 边界：本文件只读，不实现 ingestion（工程师 B 独占）。
// 入参: ?date=YYYY-MM-DD（缺省 = 当天 UTC）。出参: { date, items: [...] }。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../lib/db';
import { apiHandler } from '../../../lib/api-handler';
import { toApiErrorResponse } from '../../../lib/errors';
import { withRequestId } from '../../../lib/log';
import { getCurrentUser } from '../../../lib/auth/session';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { SUMMARY_STATUS } from '@deep-research/shared/states';

const DateQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, 'date must be YYYY-MM-DD')
    .optional(),
});

/** 把 YYYY-MM-DD 字符串（UTC 当日 00:00:00）解析成 Date 对象。 */
function parseUtcDate(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split('-').map((s) => Number(s));
  // Date.UTC 不会做本地时区换算 —— 与 summaryDate DateTime @db.Date 的语义一致
  return new Date(Date.UTC(y, m - 1, d));
}

function todayUtcDateString(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const GET = apiHandler<[NextRequest]>(async (req) => {
  // W5 fix: published 摘要公开可读，与 radar/search API 一致
  const u = await getCurrentUser();

  const requestId = withRequestId(req.headers);
  const url = new URL(req.url);
  const parsed = DateQuery.safeParse({ date: url.searchParams.get('date') ?? undefined });
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'date 参数格式错误',
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const dateStr = parsed.data.date ?? todayUtcDateString();
  const summaryDate = parseUtcDate(dateStr);

  const items = await prisma.summary.findMany({
    where: {
      status: SUMMARY_STATUS.PUBLISHED,
      summaryDate,
    },
    orderBy: [{ sortOrder: 'asc' }, { publishedAt: 'desc' }, { createdAt: 'desc' }],
    take: 4,
    select: {
      id: true,
      title: true,
      body: true,
      url: true,
      tags: true,
      contentOrigin: true,
      summaryDate: true,
      publishedAt: true,
      createdAt: true,
      source: true,
      // W5：每日摘要页展示入选理由、排序、评分
      sortOrder: true,
      selectionReason: true,
      relevanceScore: true,
      timelinessScore: true,
      sourceQualityScore: true,
    },
  });

  return NextResponse.json({
    date: dateStr,
    count: items.length,
    items: items.map((s) => ({
      id: s.id,
      title: s.title,
      // body 可能很长；列表页只取前 280 字
      excerpt: excerptOf(s.body, 280),
      url: s.url,
      tags: s.tags,
      contentOrigin: s.contentOrigin,
      summaryDate: s.summaryDate.toISOString().slice(0, 10),
      publishedAt: s.publishedAt ? s.publishedAt.toISOString() : null,
      crawledAt: s.createdAt.toISOString(),
      source: s.source,
      sortOrder: s.sortOrder,
      selectionReason: s.selectionReason,
      relevanceScore: s.relevanceScore,
      timelinessScore: s.timelinessScore,
      sourceQualityScore: s.sourceQualityScore,
    })),
  });
});

/** 取前 N 个字符；保留换行前的整段语义边界（句号/问号/感叹号/换行）。 */
function excerptOf(body: string, max: number): string {
  if (body.length <= max) return body;
  const sliced = body.slice(0, max);
  // 在最后一个句号/问号/感叹号/换行处截断；若都没有则硬截
  const m = sliced.match(/[\.!?\n][^.\n!?]*$/u);
  if (m && m.index !== undefined && m.index >= max / 2) {
    return sliced.slice(0, m.index + 1);
  }
  return sliced + '…';
}
