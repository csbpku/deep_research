// Unit tests: W4 搜索 — query builder + zod schema + 高亮防护。
//
// 测试范围：
//   - SearchQuery zod 校验（q 必填、长度、type 枚举、page/per_page 上限）
//   - buildSearchSql：参数顺序、占位符、WHERE 子句（保证触发器过滤语义）
//   - shapeSearchRow：Date → ISO、rank 精度
//   - SQL injection：参数化生效（不拼接 q）
//   - 类型守卫：isSearchableType
//
// 依赖隔离：不连接 DB；只测纯函数。

import { describe, expect, it } from 'vitest';
import {
  buildSearchSql,
  shapeSearchRow,
  detailHrefForSearchRow,
  isSearchableType,
} from '@/lib/search/query.js';
import { SearchQuery } from '@/lib/schemas.js';

// ──────────────────────────────────────────────────────────────────────
// SearchQuery zod schema
// ──────────────────────────────────────────────────────────────────────

describe('SearchQuery schema', () => {
  it('requires q to be non-empty', () => {
    const r = SearchQuery.safeParse({ q: '' });
    expect(r.success).toBe(false);
  });

  it('trims whitespace before checking min length', () => {
    const r = SearchQuery.safeParse({ q: '   ' });
    expect(r.success).toBe(false);
  });

  it('rejects q over 200 chars', () => {
    const r = SearchQuery.safeParse({ q: 'x'.repeat(201) });
    expect(r.success).toBe(false);
  });

  it('accepts q up to 200 chars', () => {
    const r = SearchQuery.safeParse({ q: 'x'.repeat(200) });
    expect(r.success).toBe(true);
  });

  it('defaults page to 1 and per_page to 20', () => {
    const r = SearchQuery.parse({ q: 'AI' });
    expect(r.page).toBe(1);
    expect(r.per_page).toBe(20);
  });

  it('rejects per_page > 50', () => {
    const r = SearchQuery.safeParse({ q: 'AI', per_page: 51 });
    expect(r.success).toBe(false);
  });

  it('accepts per_page = 50', () => {
    const r = SearchQuery.safeParse({ q: 'AI', per_page: 50 });
    expect(r.success).toBe(true);
  });

  it('rejects invalid type', () => {
    const r = SearchQuery.safeParse({ q: 'AI', type: 'unknown' });
    expect(r.success).toBe(false);
  });

  it('accepts each valid type', () => {
    for (const t of ['summary', 'long_research', 'knowledge']) {
      const r = SearchQuery.safeParse({ q: 'AI', type: t });
      expect(r.success).toBe(true);
    }
  });

  it('coerces page from string', () => {
    const r = SearchQuery.parse({ q: 'AI', page: '3' });
    expect(r.page).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildSearchSql
// ──────────────────────────────────────────────────────────────────────

describe('buildSearchSql', () => {
  it('produces parameterized SQL with $1..$4 placeholders', () => {
    const { rowsSql, params } = buildSearchSql({
      q: 'AI',
      type: undefined,
      page: 1,
      perPage: 20,
    });
    expect(rowsSql).toContain('$1');
    expect(rowsSql).toContain('$2');
    expect(rowsSql).toContain('$3');
    expect(rowsSql).toContain('$4');
    expect(params).toHaveLength(4);
    expect(params[0]).toBe('AI');
    expect(params[1]).toBeNull(); // type is undefined → null in SQL
    expect(params[2]).toBe(20);
    expect(params[3]).toBe(0); // offset = (1-1)*20
  });

  it('uses simple dictionary explicitly', () => {
    const { rowsSql, countSql } = buildSearchSql({
      q: 'AI',
      type: undefined,
      page: 1,
      perPage: 20,
    });
    // 搜索匹配：doc_tsv 是 trigger 预先生成的 tsvector 列（用 simple 字典），
    // 这里只需要 plainto_tsquery('simple', $1) 去匹配；
    // ts_headline 也用 simple 字典以保证与 doc_tsv 一致
    expect(rowsSql).toContain("plainto_tsquery('simple', $1)");
    expect(countSql).toContain("plainto_tsquery('simple', $1)");
    expect(rowsSql).toContain("ts_headline(\n        'simple'");
    // 显式不写其它字典
    expect(rowsSql).not.toContain("chinese_zh");
    expect(rowsSql).not.toContain("english");
  });

  it('uses ts_headline with <mark> tags for highlight', () => {
    const { rowsSql } = buildSearchSql({
      q: 'AI',
      type: undefined,
      page: 1,
      perPage: 20,
    });
    expect(rowsSql).toContain('ts_headline');
    expect(rowsSql).toContain('<mark>');
    expect(rowsSql).toContain('</mark>');
  });

  it('computes offset from page and perPage', () => {
    const { params } = buildSearchSql({
      q: 'AI',
      type: undefined,
      page: 3,
      perPage: 10,
    });
    expect(params[3]).toBe(20); // (3-1)*10
  });

  it('keeps type as string parameter (no string concat)', () => {
    const { params } = buildSearchSql({
      q: 'AI',
      type: 'long_research',
      page: 1,
      perPage: 20,
    });
    expect(params[1]).toBe('long_research');
  });

  it('does not concatenate q into SQL string', () => {
    const { rowsSql } = buildSearchSql({
      q: "AI' OR 1=1 --",
      type: undefined,
      page: 1,
      perPage: 20,
    });
    // q 应该作为参数；不在 SQL 字符串里
    expect(rowsSql).not.toContain('1=1');
    expect(rowsSql).not.toContain("AI' OR");
  });

  it('includes type filter in WHERE clause when provided', () => {
    const { countSql } = buildSearchSql({
      q: 'AI',
      type: 'knowledge',
      page: 1,
      perPage: 20,
    });
    expect(countSql).toContain('type::text = $2');
  });

  it('includes search_docs table (published-only by trigger)', () => {
    const { rowsSql } = buildSearchSql({
      q: 'AI',
      type: undefined,
      page: 1,
      perPage: 20,
    });
    expect(rowsSql).toContain('FROM search_docs');
    // 触发器已经过滤草稿/归档；SQL 不需要额外的 status 过滤
    expect(rowsSql).not.toContain('WHERE status');
  });

  it('excludes type filter from WHERE when not provided', () => {
    const { rowsSql, params } = buildSearchSql({
      q: 'AI',
      type: undefined,
      page: 1,
      perPage: 20,
    });
    // NULL check; SQL 用 $2 IS NULL 而非直接跳过
    expect(rowsSql).toContain('IS NULL');
    expect(params[1]).toBeNull();
  });

  it('orders by ts_rank DESC then publishedAt DESC', () => {
    const { rowsSql } = buildSearchSql({
      q: 'AI',
      type: undefined,
      page: 1,
      perPage: 20,
    });
    // 不强制正则在多行 SQL 上的贪婪匹配；改为分段断言
    expect(rowsSql).toContain('ORDER BY');
    expect(rowsSql).toContain('rank DESC');
    expect(rowsSql).toContain('"publishedAt" DESC');
    // rank 必须在 publishedAt 之前（rank DESC 是第一排序键）
    const rankIdx = rowsSql.indexOf('rank DESC');
    const pubIdx = rowsSql.indexOf('"publishedAt" DESC');
    expect(rankIdx).toBeGreaterThan(0);
    expect(pubIdx).toBeGreaterThan(rankIdx);
  });
});

// ──────────────────────────────────────────────────────────────────────
// shapeSearchRow
// ──────────────────────────────────────────────────────────────────────

describe('shapeSearchRow', () => {
  it('converts Date to ISO string', () => {
    const d = new Date('2026-07-23T10:00:00Z');
    const shaped = shapeSearchRow({
      id: 'a',
      type: 'summary',
      refId: 'r1',
      title: 't',
      snippet: 's',
      highlighted: '<mark>t</mark>',
      publishedAt: d,
      rank: 0.123456789,
    });
    expect(shaped.publishedAt).toBe('2026-07-23T10:00:00.000Z');
  });

  it('rounds rank to 4 decimal places', () => {
    const shaped = shapeSearchRow({
      id: 'a',
      type: 'summary',
      refId: 'r1',
      title: 't',
      snippet: 's',
      highlighted: '',
      publishedAt: new Date(),
      rank: 0.123456789,
    });
    expect(shaped.rank).toBe(0.1235);
  });
});

// ──────────────────────────────────────────────────────────────────────
// detailHrefForSearchRow
// ──────────────────────────────────────────────────────────────────────

describe('detailHrefForSearchRow', () => {
  it('summary → /summaries/[id]', () => {
    expect(detailHrefForSearchRow('summary', 'abc')).toBe('/summaries/abc');
  });

  it('long_research → /researches/[id]', () => {
    expect(detailHrefForSearchRow('long_research', 'abc')).toBe('/researches/abc');
  });

  it('knowledge → /researches/[id]', () => {
    expect(detailHrefForSearchRow('knowledge', 'abc')).toBe('/researches/abc');
  });
});

// ──────────────────────────────────────────────────────────────────────
// isSearchableType
// ──────────────────────────────────────────────────────────────────────

describe('isSearchableType', () => {
  it('accepts summary', () => {
    expect(isSearchableType('summary')).toBe(true);
  });

  it('accepts long_research', () => {
    expect(isSearchableType('long_research')).toBe(true);
  });

  it('accepts knowledge', () => {
    expect(isSearchableType('knowledge')).toBe(true);
  });

  it('rejects other strings', () => {
    expect(isSearchableType('research')).toBe(false);
    expect(isSearchableType('')).toBe(false);
    expect(isSearchableType('SUMMARY')).toBe(false); // 大小写敏感
  });
});

// ──────────────────────────────────────────────────────────────────────
// 中文按字节重叠匹配（simple 字典）的契约
// ──────────────────────────────────────────────────────────────────────

describe('simple-dictionary Chinese matching contract', () => {
  it('does not split CJK into single chars', () => {
    // simple 字典行为：plainto_tsquery('simple', '中文测试') 不切词；匹配靠字节重叠
    // 测试是行为契约：buildSearchSql 应该把 q 整体交给 plainto_tsquery('simple', $1)
    const { rowsSql } = buildSearchSql({
      q: '中文测试',
      type: undefined,
      page: 1,
      perPage: 20,
    });
    expect(rowsSql).toContain("plainto_tsquery('simple', $1)");
    // 不应试图切词
    expect(rowsSql).not.toContain('zhparser');
    expect(rowsSql).not.toContain('chinese_zh');
  });
});