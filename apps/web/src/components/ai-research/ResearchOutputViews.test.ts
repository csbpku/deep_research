import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { extractDecisionSummary, extractDecisionSummaryDetails, extractEvidenceMap, extractOutline, extractTables, extractBulletsFromSections, ResearchOutputViews } from './ResearchOutputViews';

describe('ResearchOutputViews', () => {
  it('derives a stable outline from report headings', () => {
    expect(extractOutline('# Decision\n\n## Evidence\n\n### Risks')).toEqual([
      { level: 1, text: 'Decision' },
      { level: 2, text: 'Evidence' },
      { level: 3, text: 'Risks' },
    ]);
  });

  it('extracts complete markdown tables without changing the source', () => {
    const table = '| Tool | Fit |\n| --- | --- |\n| A | High |\n| B | Low |';
    expect(extractTables(`Intro\n\n${table}\n\nAfter`)).toEqual([table]);
  });

  it('derives decision, risks, actions and evidence links from the same report', () => {
    const report = [
      '# Report',
      '## 结论',
      '建议先做小流量验证。',
      '## 风险与限制',
      '- 数据覆盖不足',
      '- 成本需要观测',
      '## 下一步行动',
      '1. 建立基线',
      '2. 运行灰度',
      '## 证据',
      '[官方文档](https://example.com/docs)',
    ].join('\n');
    expect(extractDecisionSummary(report)).toContain('建议先做小流量验证');
    expect(extractBulletsFromSections(report, /风险/iu)).toEqual(['数据覆盖不足', '成本需要观测']);
    expect(extractBulletsFromSections(report, /行动/iu)).toEqual(['建立基线', '运行灰度']);
    expect(extractEvidenceMap(report, [{ id: '1', title: '官方文档', href: 'https://example.com/docs' }])).toEqual([
      { section: '证据', citations: [{ title: '官方文档', href: 'https://example.com/docs' }] },
    ]);
  });

  it('keeps the fallback decision view short when a report has no summary section', () => {
    const report = ['# 报告标题', ...Array.from({ length: 12 }, (_, index) => `开头信息 ${index + 1}`)].join('\n');
    const summary = extractDecisionSummary(report);

    expect(summary).toContain('开头信息 1');
    expect(summary).not.toContain('开头信息 12');
    expect(summary?.length).toBeLessThanOrEqual(960);
  });

  it('does not present a fallback excerpt as a confirmed decision', () => {
    const report = '# Report\n\nBackground only';
    expect(extractDecisionSummary(report)).toBe('Background only');
    expect(extractDecisionSummaryDetails(report)).toEqual({ text: 'Background only', explicit: false });
  });

  it('marks a report conclusion as an explicit decision source', () => {
    expect(extractDecisionSummaryDetails('## 结论\n\n建议先做灰度验证。')).toEqual({
      text: '建议先做灰度验证。',
      explicit: true,
    });
  });

  it('renders the web brief as an independent reading layout, not a slide preview', () => {
    const html = renderToStaticMarkup(createElement(ResearchOutputViews, {
      content: '# Research title\n\n## 结论\n\n先做灰度验证。\n\n## 风险与限制\n\n- 证据覆盖不足\n\n## 下一步行动\n\n1. 建立基线',
      artifactType: 'markdown',
      presentationType: 'web',
      sources: [],
    }));

    expect(html).toContain('独立网页阅读版');
    expect(html).toContain('一页判断');
    expect(html).toContain('详细报告');
    expect(html).not.toContain('Slides 提纲预览');
    expect(html.split('先做灰度验证').length - 1).toBe(1);
  });

  it('passes the review state into the independent web brief', () => {
    const html = renderToStaticMarkup(createElement(ResearchOutputViews, {
      content: '# Research title\n\n## 结论\n\n先做灰度验证。',
      artifactType: 'markdown',
      presentationType: 'web',
      reviewStatus: 'passed',
    }));

    expect(html).toContain('可以直接参考');
    expect(html).not.toContain('事实审核');
  });
});
