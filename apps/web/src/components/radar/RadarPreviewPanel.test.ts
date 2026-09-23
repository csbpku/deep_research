import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RadarPreviewPanel } from './RadarPreviewPanel';

describe('RadarPreviewPanel', () => {
  it('keeps the list preview focused on a reading decision', () => {
    const html = renderToStaticMarkup(createElement(RadarPreviewPanel, {
      detail: {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'A technical article',
        excerpt: 'A longer source excerpt with enough context for a quick decision.',
        interpretation: 'A concise AI interpretation.',
        scoreReason: null,
        distilledScore: null,
        tier: 'skim',
        selectionReason: 'It contains a practical implementation signal.',
        url: 'https://example.com/article',
        sourceType: 'rss',
        sourceName: 'Engineering Feed',
        tags: ['engineering'],
        publishedAt: '2026-09-20T00:00:00.000Z',
      },
      onClose: () => undefined,
    }));

    expect(html).toContain('快速预览');
    expect(html).toContain('AI 摘要');
    expect(html).not.toContain('line-clamp-6');
    expect(html).toContain('为什么值得看');
    expect(html).toContain('打开原文');
    expect(html).toContain('深入调研');
    expect(html).not.toContain('查看完整详情');
    expect(html).not.toContain('评分详情');
  });

  it('does not add filler reading advice when no selection reason exists', () => {
    const html = renderToStaticMarkup(createElement(RadarPreviewPanel, {
      detail: {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Another technical article',
        excerpt: 'Source context.',
        interpretation: 'A concise AI interpretation.',
        scoreReason: null,
        distilledScore: null,
        tier: 'deep_read',
        selectionReason: null,
        url: 'https://example.com/another-article',
        sourceType: 'rss',
        sourceName: 'Engineering Feed',
        tags: [],
        publishedAt: '2026-09-20T00:00:00.000Z',
      },
      onClose: () => undefined,
    }));

    expect(html).not.toContain('阅读建议');
    expect(html).not.toContain('先看摘要，再决定是否打开原文');
    expect(html).not.toContain('排序参考');
  });

  it('splits GitHub repository actions into GitHub and Zread', () => {
    const html = renderToStaticMarkup(createElement(RadarPreviewPanel, {
      detail: {
        id: '33333333-3333-4333-8333-333333333333',
        title: 'microsoft/markitdown',
        excerpt: 'Repository context.',
        interpretation: 'Repository summary.',
        scoreReason: null,
        distilledScore: null,
        tier: 'deep_read',
        selectionReason: null,
        url: 'https://github.com/microsoft/markitdown',
        sourceType: 'github',
        sourceName: 'GitHub',
        originalKind: 'github_repo',
        tags: [],
        publishedAt: null,
      },
      onClose: () => undefined,
    }));

    expect(html).toContain('打开 GitHub');
    expect(html).toContain('打开 Zread');
    expect(html).toContain('https://zread.ai/microsoft/markitdown');
  });
});
