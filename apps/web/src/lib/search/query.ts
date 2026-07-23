// Search query builder —— 构造 raw SQL 用于 search_docs。
//
// 契约源：docs/agent-prompts/week4-engineer-a.md §任务 2
// 约束：
//   - 必须用 simple 字典（zhparser 装机阻塞，docs/decisions/0006-w4-zhparser-deferred.md）
//   - 参数化查询；禁止拼接
//   - 触发器已保证 search_docs 只含 published；无需额外 WHERE 过滤
//   - 中文按字节重叠匹配（simple 字典行为）

import type { Prisma } from '@prisma/client';

/**
 * 搜索参数。
 * q.trim() 已由上游 zod 完成；这里不再 trim。
 */
export interface BuildSearchArgs {
  q: string;
  type?: 'summary' | 'long_research' | 'knowledge' | undefined;
  page: number;
  perPage: number;
}

export interface SearchRow {
  id: string;
  type: string;
  refId: string;
  title: string;
  snippet: string;
  highlighted: string;
  publishedAt: Date;
  rank: number;
}

/**
 * 构造搜索查询 SQL + 参数。
 * 返回 { sql, params, whereClause } 三件套：
 *   - sql:    完整的 SELECT（含 ts_headline 高亮、ts_rank 排序、分页）
 *   - params: 参数数组；按 PG $1/$2/$3 顺序
 *
 * 返回的两段 SQL 是分开构造的，便于在测试中单测 whereClause 是否被触发器"自然过滤"覆盖。
 *
 * ts_headline 参数：'StartSel=<mark>, StopSel=</mark>, MaxWords=20, MinWords=5'
 *   - 中文按字节重叠匹配；20 词上限覆盖中等长度段落
 */
export function buildSearchSql(args: BuildSearchArgs): {
  rowsSql: string;
  countSql: string;
  params: unknown[];
} {
  const { q, type, page, perPage } = args;
  const offset = (page - 1) * perPage;

  // 三类枚举的 tsquery 字符串都复用 plainto_tsquery('simple', $1)
  // 参数顺序：$1=q, $2=type (nullable), $3=limit, $4=offset
  const rowsSql = `
    SELECT
      id,
      type::text AS type,
      "refId",
      title,
      snippet,
      ts_headline(
        'simple',
        snippet,
        plainto_tsquery('simple', $1),
        'StartSel=<mark>, StopSel=</mark>, MaxWords=20, MinWords=5'
      ) AS highlighted,
      "publishedAt",
      ts_rank(doc_tsv, plainto_tsquery('simple', $1))::float8 AS rank
    FROM search_docs
    WHERE doc_tsv @@ plainto_tsquery('simple', $1)
      AND ($2::text IS NULL OR type::text = $2)
    ORDER BY rank DESC, "publishedAt" DESC
    LIMIT $3 OFFSET $4
  `;

  const countSql = `
    SELECT count(*)::int AS total
    FROM search_docs
    WHERE doc_tsv @@ plainto_tsquery('simple', $1)
      AND ($2::text IS NULL OR type::text = $2)
  `;

  return {
    rowsSql,
    countSql,
    params: [q, type ?? null, perPage, offset],
  };
}

/**
 * 把 Prisma 返回的 row 转成 API 响应需要的形状（数字 → string/dict）。
 * publishedAt: Date → ISO string；rank: number → 4 位精度浮点。
 */
export function shapeSearchRow(row: {
  id: string;
  type: string;
  refId: string;
  title: string;
  snippet: string;
  highlighted: string;
  publishedAt: Date;
  rank: number;
}) {
  return {
    id: row.id,
    type: row.type,
    refId: row.refId,
    title: row.title,
    snippet: row.snippet,
    highlighted: row.highlighted,
    publishedAt: row.publishedAt.toISOString(),
    rank: Number(row.rank.toFixed(4)),
  };
}

/**
 * 详情链接：根据 search_doc.type 决定指向哪个详情页。
 * - summary → /summaries/{refId}
 * - long_research / knowledge → /researches/{refId}
 */
export function detailHrefForSearchRow(type: string, refId: string): string {
  if (type === 'summary') return `/summaries/${refId}`;
  return `/researches/${refId}`;
}

/**
 * Type guard：保留给将来其他模块复用，目前仅文档化。
 */
export function isSearchableType(t: string): t is 'summary' | 'long_research' | 'knowledge' {
  return t === 'summary' || t === 'long_research' || t === 'knowledge';
}

/** 类型 re-export 保留，便于 IDE 推断。 */
export type SearchArgs = Prisma.Sql;