// BFF handler: GET /api/search — 全文搜索
//
// 契约源：
//   - docs/archive/2026-09-08-agent-prompts/week4-engineer-a.md §任务 2
//   - SearchDoc（公开已发布内容）+ summaries 中的可见雷达候选 + 本人研究/知识草稿
//   - simple 字典全文检索 + pg_trgm 近似匹配
//
// 入参：q (1-200)、type (summary|long_research|knowledge|radar，可选)、page、per_page (≤50)
// 出参：{ items: SearchRow[], total, page, per_page }
// 权限：公开结果沿用现有可见性；登录用户额外看到仅本人可见的研究/知识草稿。
//
// 注意：
//   - 不引入新错误码；用现有 VALIDATION_FAILED 兜底校验错误。
//   - 不记搜索关键词原文到日志（隐私）；只记 query 长度 + 类型。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../lib/db';
import { apiHandler } from '../../../lib/api-handler';
import { toApiErrorResponse } from '../../../lib/errors';
import { log, withRequestId } from '../../../lib/log';
import { SearchQuery } from '../../../lib/schemas';
import { buildSearchSql, shapeSearchRow, isSearchableType } from '../../../lib/search/query';
import { getCurrentUserId } from '../../../lib/auth/session';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  // 搜索对已登录和匿名用户都开放；雷达候选与 /api/radar 的公开可见性一致。

  const url = new URL(req.url);
  const parsed = SearchQuery.safeParse({
    q: url.searchParams.get('q') ?? '',
    type: url.searchParams.get('type') ?? undefined,
    page: url.searchParams.get('page') ?? undefined,
    per_page: url.searchParams.get('per_page') ?? undefined,
  });
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '搜索参数不合法',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { q, type, page, per_page } = parsed.data;
  const userId = await getCurrentUserId();

  // type 不在合法 enum 时也走 VALIDATION_FAILED（已由 zod 处理）

  const { rowsSql, countSql, params } = buildSearchSql({
    q,
    type: type && isSearchableType(type) ? type : undefined,
    userId,
    page,
    perPage: per_page,
  });

  // Prisma.$queryRaw + 任意类型断言；返回字段名与 buildSearchSql SELECT 一致
  type RawRow = {
    id: string;
    type: string;
    refId: string;
    title: string;
    snippet: string;
    highlighted: string;
    publishedAt: Date;
    rank: number;
    isPrivate: boolean;
  };
  type RawCount = { total: number };

  const [rows, countRows] = await Promise.all([
    prisma.$queryRawUnsafe<RawRow[]>(rowsSql, ...params),
    prisma.$queryRawUnsafe<RawCount[]>(countSql, params[0], params[1], params[2]),
  ]);
  const total = countRows[0]?.total ?? 0;

  log.info('search.query', 'search executed', {
    requestId,
    queryLength: q.length,
    type: type ?? 'all',
    total,
    page,
    perPage: per_page,
  });

  return NextResponse.json({
    items: rows.map(shapeSearchRow),
    total,
    page,
    per_page,
    totalPages: Math.ceil(total / per_page),
  });
});
