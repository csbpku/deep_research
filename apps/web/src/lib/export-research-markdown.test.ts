import { describe, expect, it } from 'vitest';
import { buildResearchMarkdown, researchMarkdownFilename } from './export-research-markdown';

const base = {
  title: 'Playwright 分片',
  background: '需要并行',
  conclusion: '用 --shard',
  risks: null,
  body: '# 决策备忘\n\n正文',
  tags: ['playwright', 'ci'],
  publishedAt: null,
};

describe('buildResearchMarkdown', () => {
  it('renders the summary sections in publish order and skips empty ones', () => {
    const md = buildResearchMarkdown(base);
    expect(md).toContain('# Playwright 分片');
    expect(md).toContain('> 标签：playwright、ci');
    expect(md).toContain('## 背景\n\n需要并行');
    expect(md).toContain('## 结论\n\n用 --shard');
    expect(md).not.toContain('## 风险与待验证');
    expect(md).toContain('## 正文\n\n# 决策备忘');
  });

  it('adds publication time and trims the trailing section', () => {
    const md = buildResearchMarkdown({ ...base, publishedAt: '2026-11-11T09:00:00.000Z' });
    expect(md).toContain('> 发布：');
    expect(md.endsWith('\n')).toBe(true);
  });
});

describe('researchMarkdownFilename', () => {
  it('replaces path separators and caps the name', () => {
    expect(researchMarkdownFilename('a/b:c')).toBe('a b c.md');
    expect(researchMarkdownFilename('   ')).toBe('research.md');
  });
});
