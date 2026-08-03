// Search query builder —— 构造 raw SQL 用于 search_docs。
//
// 契约源：docs/agent-prompts/week4-engineer-a.md §任务 2
// 约束：
//   - simple 字典全文检索 + pg_trgm 近似匹配（两者均已在基础 migration 启用）
//   - 参数化查询；禁止拼接
//   - search_docs 保持 published-only；雷达候选从 summaries 动态加入
//   - 全部结果中，已发布雷达只保留 radar 形态，避免与 summary 重复

import type { Prisma } from '@prisma/client';

/**
 * 搜索参数。
 * q.trim() 已由上游 zod 完成；这里不再 trim。
 */
export interface BuildSearchArgs {
  q: string;
  type?: SearchableType | undefined;
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

export type SearchableType = 'summary' | 'long_research' | 'knowledge' | 'radar';

/**
 * 构造搜索查询 SQL + 参数。
 * 返回 { sql, params, whereClause } 三件套：
 *   - sql:    完整的 SELECT（含 ts_headline 高亮、ts_rank 排序、分页）
 *   - params: 参数数组；按 PG $1/$2/$3 顺序
 *
 * 返回的两段 SQL 是分开构造的，便于在测试中单测 whereClause 是否被触发器"自然过滤"覆盖。
 *
 * 混合召回：
 *   - websearch_to_tsquery：支持普通多词、引号短语和 OR
 *   - pg_trgm similarity：补轻微拼写差异和不适合 simple 分词的中文
 *   - strpos：保证精确子串稳定命中；标题权重大于正文/解读/标签
 */
export function buildSearchSql(args: BuildSearchArgs): {
  rowsSql: string;
  countSql: string;
  params: unknown[];
} {
  const { q, type, page, perPage } = args;
  const offset = (page - 1) * perPage;

  // 四类结果共用同一组参数；SQL 全部静态，用户输入只通过占位符进入。
  // 参数顺序：$1=q, $2=type (nullable), $3=limit, $4=offset
  const matchesSql = `
    WITH search_query AS (
      SELECT
        websearch_to_tsquery('simple', $1) AS tsq,
        lower($1) AS needle
    ),
    matches AS (
      SELECT
        sd.id::text AS id,
        sd.type::text AS type,
        sd."refId",
        sd.title,
        sd.snippet,
        ts_headline(
          'simple',
          sd.snippet,
          sq.tsq,
          'StartSel=<mark>, StopSel=</mark>, MaxWords=20, MinWords=5'
        ) AS highlighted,
        sd."publishedAt",
        (
          ts_rank(sd.doc_tsv, sq.tsq) * 4
          + CASE WHEN lower(sd.title) = sq.needle THEN 8 ELSE 0 END
          + CASE WHEN strpos(lower(sd.title), sq.needle) > 0 THEN 4 ELSE 0 END
          + greatest(
              similarity(lower(sd.title), sq.needle),
              strict_word_similarity(sq.needle, lower(sd.title))
            ) * 3
          + strict_word_similarity(sq.needle, lower(sd.snippet)) * 1.5
        )::float8 AS rank
      FROM search_docs sd
      CROSS JOIN search_query sq
      WHERE (
        sd.doc_tsv @@ sq.tsq
        OR strpos(lower(sd.title), sq.needle) > 0
        OR strpos(lower(sd.snippet), sq.needle) > 0
        OR (
          char_length(sq.needle) >= 3
          AND greatest(
            similarity(lower(sd.title), sq.needle),
            strict_word_similarity(sq.needle, lower(sd.title)),
            strict_word_similarity(sq.needle, lower(sd.snippet))
          ) >= 0.35
        )
      )
      AND (
        $2::text IS NOT NULL
        OR sd.type::text <> 'summary'
        OR NOT EXISTS (
          SELECT 1
          FROM summaries radar_summary
          WHERE radar_summary.id = sd."refId"
            AND radar_summary.source::text = 'daily'
            AND radar_summary."syncRunId" IS NOT NULL
        )
      )

      UNION ALL

      SELECT
        'radar:' || s.id::text AS id,
        'radar'::text AS type,
        s.id AS "refId",
        s.title,
        left(coalesce(nullif(s.interpretation, ''), s.body), 1000) AS snippet,
        ts_headline(
          'simple',
          left(coalesce(nullif(s.interpretation, ''), s.body), 1000),
          sq.tsq,
          'StartSel=<mark>, StopSel=</mark>, MaxWords=20, MinWords=5'
        ) AS highlighted,
        coalesce(s."publishedAt", s."createdAt") AS "publishedAt",
        (
          ts_rank(
            setweight(to_tsvector('simple', coalesce(s.title, '')), 'A')
              || setweight(to_tsvector('simple', coalesce(s.interpretation, '')), 'B')
              || setweight(to_tsvector('simple', array_to_string(s.tags, ' ')), 'B')
              || setweight(to_tsvector('simple', coalesce(s.body, '')), 'C'),
            sq.tsq
          ) * 4
          + CASE WHEN lower(s.title) = sq.needle THEN 8 ELSE 0 END
          + CASE WHEN strpos(lower(s.title), sq.needle) > 0 THEN 4 ELSE 0 END
          + CASE WHEN EXISTS (
              SELECT 1 FROM unnest(s.tags) tag WHERE lower(tag) = sq.needle
            ) THEN 3 ELSE 0 END
          + greatest(
              similarity(lower(s.title), sq.needle),
              strict_word_similarity(sq.needle, lower(s.title))
            ) * 3
          + strict_word_similarity(sq.needle, lower(coalesce(s.interpretation, ''))) * 1.5
          + strict_word_similarity(sq.needle, lower(left(s.body, 2000))) * 0.75
        )::float8 AS rank
      FROM summaries s
      CROSS JOIN search_query sq
      WHERE s.source::text = 'daily'
        AND s."syncRunId" IS NOT NULL
        AND s.status::text <> 'archived'
        AND (
          (
            setweight(to_tsvector('simple', coalesce(s.title, '')), 'A')
              || setweight(to_tsvector('simple', coalesce(s.interpretation, '')), 'B')
              || setweight(to_tsvector('simple', array_to_string(s.tags, ' ')), 'B')
              || setweight(to_tsvector('simple', coalesce(s.body, '')), 'C')
          ) @@ sq.tsq
          OR strpos(lower(s.title), sq.needle) > 0
          OR strpos(lower(coalesce(s.interpretation, '')), sq.needle) > 0
          OR strpos(lower(s.body), sq.needle) > 0
          OR EXISTS (
            SELECT 1 FROM unnest(s.tags) tag WHERE strpos(lower(tag), sq.needle) > 0
          )
          OR (
            char_length(sq.needle) >= 3
            AND greatest(
              similarity(lower(s.title), sq.needle),
              strict_word_similarity(sq.needle, lower(s.title)),
              strict_word_similarity(sq.needle, lower(coalesce(s.interpretation, ''))),
              strict_word_similarity(sq.needle, lower(left(s.body, 2000)))
            ) >= 0.35
          )
        )
    )
  `;

  const rowsSql = `${matchesSql}
    SELECT
      id,
      type,
      "refId",
      title,
      snippet,
      highlighted,
      "publishedAt",
      rank
    FROM matches
    WHERE ($2::text IS NULL OR type = $2)
    ORDER BY rank DESC, "publishedAt" DESC
    LIMIT $3 OFFSET $4
  `;

  const countSql = `${matchesSql}
    SELECT count(*)::int AS total
    FROM matches
    WHERE ($2::text IS NULL OR type = $2)
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
    highlighted: sanitizeSearchHighlight(row.highlighted),
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
  if (type === 'radar') return `/radar/${refId}`;
  if (type === 'summary') return `/summaries/${refId}`;
  return `/researches/${refId}`;
}

/**
 * Type guard：保留给将来其他模块复用，目前仅文档化。
 */
export function isSearchableType(t: string): t is SearchableType {
  return t === 'summary' || t === 'long_research' || t === 'knowledge' || t === 'radar';
}

/** 只允许数据库高亮器生成的 <mark>，其余来源文本一律转义。 */
export function sanitizeSearchHighlight(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('&lt;mark&gt;', '<mark>')
    .replaceAll('&lt;/mark&gt;', '</mark>');
}

/** 类型 re-export 保留，便于 IDE 推断。 */
export type SearchArgs = Prisma.Sql;
