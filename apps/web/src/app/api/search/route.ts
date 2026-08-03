// BFF handler: GET /api/search — 全文搜索
//
// 契约源：
//   - docs/agent-prompts/week4-engineer-a.md §任务 2
//   - SearchDoc（published-only）+ summaries 中的雷达候选
//   - simple 字典全文检索 + pg_trgm 近似匹配
//
// 入参：q (1-200)、type (summary|long_research|knowledge|radar，可选)、page、per_page (≤50)
// 出参：{ items: SearchRow[], total, page, per_page }
// 权限：已登录可访问；搜索结果只可能来自已发布内容（trigger 过滤）。
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

  // type 不在合法 enum 时也走 VALIDATION_FAILED（已由 zod 处理）

  const { rowsSql, countSql, params } = buildSearchSql({
    q,
    type: type && isSearchableType(type) ? type : undefined,
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
  };
  type RawCount = { total: number };

  const [rows, countRows] = await Promise.all([
    prisma.$queryRawUnsafe<RawRow[]>(rowsSql, ...params),
    prisma.$queryRawUnsafe<RawCount[]>(countSql, params[0], params[1]),
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
