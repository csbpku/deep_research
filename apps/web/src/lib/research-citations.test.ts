import { describe, expect, it } from 'vitest';

import { compactResearchCitations } from './research-citations';

const duckDbHref = 'https://builder.ai2sql.io/blog/duckdb-vs-sqlite-vs-postgresql';
const postgresHref = 'https://www.postgresql.org/docs/16/index.html';

describe('compactResearchCitations', () => {
  it('compacts source-backed Markdown links and appends a deduplicated bibliography', () => {
    const output = compactResearchCitations([
      '# 数据库选型',
      '',
      `DuckDB 适合作为另一分支的证据有限 [DuckDB 对比文](<${duckDbHref}>)。`,
      `同一来源不应重复计数 [再次引用](${duckDbHref})。`,
    ].join('\n'), [
      { title: 'DuckDB vs SQLite vs PostgreSQL：选择哪种数据库？', href: duckDbHref },
    ]);

    expect(output).toContain('DuckDB 适合作为另一分支的证据有限 [1](#bib-1)。');
    expect(output).toContain('同一来源不应重复计数 [1](#bib-1)。');
    expect(output).toContain('## 参考文献');
    expect(output).toContain(`- **[1]** [DuckDB vs SQLite vs PostgreSQL：选择哪种数据库？](<${duckDbHref}>)`);
    expect(output.match(/#bib-1/gu)?.length).toBe(2);
  });

  it('uses the captured source title and replaces an existing bibliography without duplicating it', () => {
    const output = compactResearchCitations([
      '# 研究',
      '',
      `结论 [官方文档](${postgresHref})。`,
      '',
      '## 参考文献',
      '',
      `1. 旧标题 [旧标题](${postgresHref})`,
    ].join('\n'), [
      { title: 'PostgreSQL 16 官方文档', href: postgresHref },
    ]);

    expect(output).toContain(`[1](#bib-1)`);
    expect(output).toContain(`- **[1]** [PostgreSQL 16 官方文档](<${postgresHref}>)`);
    expect(output).not.toContain('旧标题');
    expect(output.match(/PostgreSQL 16 官方文档/gu)?.length).toBe(1);
  });

  it('does not compact links that are not present in the current source ledger', () => {
    const body = `[未验证链接](${duckDbHref})`;
    expect(compactResearchCitations(body, [])).toBe(body);
    expect(compactResearchCitations(body, [{ title: '其他来源', href: postgresHref }])).toBe(body);
  });

  it('does not touch fenced code, inline code, or image links', () => {
    const output = compactResearchCitations([
      `![架构图](${duckDbHref}/diagram.png)`,
      '',
      `\`[代码中的链接](${duckDbHref})\``,
      '',
      '```md',
      `[代码块链接](${duckDbHref})`,
      '```',
      '',
      `[正文链接](${duckDbHref})`,
    ].join('\n'), [
      { title: 'DuckDB 对比', href: duckDbHref },
    ]);

    expect(output).toContain(`![架构图](${duckDbHref}/diagram.png)`);
    expect(output).toContain(`\`[代码中的链接](${duckDbHref})\``);
    expect(output).toContain(`[代码块链接](${duckDbHref})`);
    expect(output).toContain('[1](#bib-1)');
    expect(output).toContain(`- **[1]** [DuckDB 对比](<${duckDbHref}>)`);
  });

  it('also compacts a visible bare HTTPS URL when it is source-backed', () => {
    const output = compactResearchCitations(`网络实测见 ${postgresHref}。`, [
      { title: 'PostgreSQL 16 文档', href: postgresHref },
    ]);

    expect(output).toContain('网络实测见 [1](#bib-1)。');
    expect(output).toContain(`- **[1]** [PostgreSQL 16 文档](<${postgresHref}>)`);
  });
});
