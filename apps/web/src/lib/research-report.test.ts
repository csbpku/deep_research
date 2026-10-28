import { describe, expect, it } from 'vitest';

import { buildEvidenceDigest, cleanEvidenceSnippet, cleanResearchReportForReader, extractResearchTitle, extractSlideLimit, isEvidenceOnlyResearchOutput, renderSlidesArtifactContent } from './research-report';

describe('extractResearchTitle', () => {
  it('uses the first report heading instead of the full research question', () => {
    expect(extractResearchTitle(
      '# 项目框架迁移评估报告：Playwright 是否应替代 Cypress？\n\n## 一页判断\n建议先做小规模验证。',
      'Playwright 和 Cypress 哪一个更适合我们的项目？',
    )).toBe('项目框架迁移评估报告：Playwright 是否应替代 Cypress？');
  });

  it('falls back when a report has no level-one heading', () => {
    expect(extractResearchTitle('## 结论\n先验证再迁移。', '原始研究问题')).toBe('原始研究问题');
  });

  it('removes lightweight markdown formatting from the label', () => {
    expect(extractResearchTitle('# **方案**：`Playwright`')).toBe('方案：Playwright');
  });
});

describe('cleanResearchReportForReader', () => {
  it('removes a model drafting scratchpad before the real report', () => {
    const raw = [
      'The user is asking whether to adopt GraphRAG.',
      'Let me analyze the evidence.',
      '# Main title: GraphRAG report',
      'I should structure the report carefully.',
      '# 是否应该采用 GraphRAG？',
      '## 结论',
      '建议先做小规模验证。',
    ].join('\n\n');

    const cleaned = cleanResearchReportForReader(raw);
    expect(cleaned).toMatch(/^# 是否应该采用 GraphRAG？/u);
    expect(cleaned).not.toContain('The user is asking');
    expect(cleaned).not.toContain('Main title');
  });

  it('keeps collected links and marks uncollected links as unverified', () => {
    const cleaned = cleanResearchReportForReader(
      '[真实来源](https://a.example/post) [构造来源](https://fake.example/post)',
      ['https://a.example/post'],
    );

    expect(cleaned).toContain('[真实来源](https://a.example/post)');
    expect(cleaned).not.toContain('https://fake.example');
    expect(cleaned).toContain('构造来源（链接未被本次来源验证）');
  });

  it('treats every report link as unverified when no evidence records were saved', () => {
    const cleaned = cleanResearchReportForReader('[历史引用](https://legacy.example/post)');

    expect(cleaned).toBe('历史引用（链接未被本次来源验证）');
  });

  it('repairs provider bold delimiters with an extra leading space', () => {
    const cleaned = cleanResearchReportForReader('结论：** P0 引用治理**，然后继续。');

    expect(cleaned).toBe('结论：**P0 引用治理**，然后继续。');
  });
});

describe('isEvidenceOnlyResearchOutput', () => {
  it('recognizes a legacy source digest as non-publishable', () => {
    expect(isEvidenceOnlyResearchOutput(
      '> 本轮已完成资料检索，但报告模型没有返回可发布的研究正文。\n\n- 研究结论：待补写',
    )).toBe(true);
  });

  it('does not downgrade a real report that mentions evidence gaps', () => {
    expect(isEvidenceOnlyResearchOutput(
      '# 研究结论\n\n本轮已完成资料检索，但仍有一条结论待补写。',
    )).toBe(false);
  });
});

describe('renderSlidesArtifactContent', () => {
  it('normalizes a legacy report into an inspectable multi-page outline', () => {
    const deck = renderSlidesArtifactContent(
      '# Findings\n\nIntro.\n\n## Evidence\n\nA claim.\n\n## Risks\n\nA risk.',
      'Topic',
    );

    expect(deck).toContain('## Slide 1: Findings');
    expect(deck).toContain('## Slide 2: Evidence');
    expect(deck).toContain('## Slide 3: Risks');
    expect(deck).not.toContain('# Topic\n\n# Findings');
  });

  it('does not double-wrap already-rendered slide markdown', () => {
    const deck = '## Slide 1: Evidence\n\nA claim.';
    expect(renderSlidesArtifactContent(deck, 'Topic')).toBe(deck);
  });

  it('reads the user page limit and preserves all sections within that limit', () => {
    const report = Array.from({ length: 9 }, (_, index) => `## Section ${index + 1}\n\nEvidence ${index + 1}.`).join('\n\n');
    const deck = renderSlidesArtifactContent(report, '请输出 6 页以内的 Slides 提纲');
    expect(extractSlideLimit('请输出 6 页以内的 Slides 提纲')).toBe(6);
    expect(deck.match(/^## Slide \d+:/gmu)).toHaveLength(6);
    for (let index = 1; index <= 9; index += 1) expect(deck).toContain(`Evidence ${index}.`);
  });

  it('clamps unreasonable page limits instead of producing an unbounded deck', () => {
    expect(extractSlideLimit('up to 99 slides')).toBe(12);
    expect(extractSlideLimit('最多 1 页')).toBe(3);
  });
});

describe('buildEvidenceDigest', () => {
  it('creates an inspectable read-only snapshot without inventing a conclusion', () => {
    const digest = buildEvidenceDigest('GraphRAG 选型', [
      {
        title: '官方文档',
        href: 'https://example.com/docs',
        snippet: '原文说明了索引流程。',
        capturedAt: '2026-09-03T10:00:00Z',
      },
    ]);

    expect(digest).toContain('这是本轮实际抓取的资料快照，不是研究结论');
    expect(digest).toContain('[官方文档](https://example.com/docs)');
    expect(digest).toContain('原文说明了索引流程。');
    expect(digest).not.toContain('建议采用');
  });

  it('returns no snapshot when there is no inspectable body', () => {
    expect(buildEvidenceDigest('空任务', [{ title: '没有正文', snippet: '   ' }])).toBeNull();
  });
});

describe('cleanEvidenceSnippet', () => {
  it('removes presentation wrappers while keeping the excerpt readable', () => {
    expect(cleanEvidenceSnippet('## Title ![diagram](image.png) [docs](https://example.com) **important**')).toBe(
      'Title diagram docs important',
    );
  });
});

it('honors a requested five-page outline and preserves all sections', () => {
  const report = Array.from({ length: 7 }, (_, i) => `## Slide ${i + 1}: Finding\n\nEvidence ${i + 1}.`).join('\n\n');
  expect(extractSlideLimit('用5页提纲说明异步任务差异')).toBe(5);
  const deck = renderSlidesArtifactContent(report, '用5页提纲说明异步任务差异');
  expect(deck.match(/^## Slide \d+:/gm)).toHaveLength(5);
  for (let i = 1; i <= 7; i++) expect(deck).toContain(`Evidence ${i}.`);
});


it('keeps numbered slide boundaries and places references outside the deck', () => {
  const pages = ['封面', 'gather', 'TaskGroup', '边界', '结论'].map((label, index) => `## Slide ${index + 1}: ${label}\n\n正文${index + 1}`).join('\n\n');
  const report = `# 文稿标题\n\n开场背景\n\n${pages}\n\n## 参考文献\n\n- [来源](https://example.test/doc)`;
  const deck = renderSlidesArtifactContent(report, '用5页说明');
  expect(deck.match(/^## Slide /gmu)).toHaveLength(5);
  expect(deck.startsWith('## Slide 1: 封面')).toBe(true);
  expect(deck.split('## Slide 2:')[0]).toContain('# 文稿标题');
  expect(deck.split('## Slide 2:')[1].split('## Slide 3:')[0]).toContain('正文2');
  expect(deck.split('## Slide 3:')[1].split('## Slide 4:')[0]).toContain('正文3');
  expect(deck.endsWith('## 参考文献\n\n- [来源](https://example.test/doc)')).toBe(true);
  expect(renderSlidesArtifactContent(deck, '用5页说明')).toBe(deck);
});

it('keeps overflowing numbered page content and moves reference slides to an appendix', () => {
  const pages = Array.from({ length: 7 }, (_, index) => `## Slide ${index + 1}: 标题${index + 1}\n\n正文${index + 1}`).join('\n\n');
  const deck = renderSlidesArtifactContent(`# 文稿标题\n\n${pages}\n\n## Slide 8: 参考文献\n\n- 来源A`, '用5页说明');
  expect(deck.match(/^## Slide /gmu)).toHaveLength(5);
  for (let i = 1; i <= 7; i += 1) { expect(deck).toContain(`标题${i}`); expect(deck).toContain(`正文${i}`); }
  expect(deck.endsWith('## 参考文献\n\n- 来源A')).toBe(true);
});
