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

    expect(html).toContain('文章概览');
    // "为什么值得看"现在由 AI 摘要承担，不再是永远不渲染的死段落。
    expect(html).toContain('为什么值得看');
    expect(html).toContain('摘要与评分基于同步时可用的资料；请打开原文或 Reader 核对');
    expect(html).not.toContain('line-clamp-6');
    expect(html).not.toContain('AI 摘要');
    expect(html).toContain('打开原文');
    // Reader 保留原文上下文，网页默认入口指向商店。
    expect(html).toContain('用 Reader 阅读');
    expect(html).toContain('data-reader-launch-source=');
    expect(html).toContain('href="https://chromewebstore.google.com/detail/bldpmkepljipbadeegednfinnilgoedl"');
    expect(html).toContain('href="https://example.com/article"');
    expect(html).toContain('深入调研');
    expect(html).not.toContain('查看完整详情');
    expect(html).not.toContain('评分详情');
  });

  it.each([
    {
      tags: ['evidence_feed_excerpt', 'ai'],
      scoreReason: null,
      message: '该文章曾使用 RSS 来源片段生成摘要或评分；原文覆盖情况请打开原文核实。',
    },
    {
      tags: ['ai'],
      scoreReason: '来源摘要初筛：未能取得原文正文，评分仅供发现排序；请打开原文复核。',
      message: '摘要与评分基于来源摘要，未能取得原文正文；请打开原文复核。',
    },
  ])('reveals a limited evidence scope in the preview', ({ tags, scoreReason, message }) => {
    const html = renderToStaticMarkup(createElement(RadarPreviewPanel, {
      detail: {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Limited source evidence',
        excerpt: 'Source context.',
        interpretation: 'A concise interpretation.',
        scoreReason,
        distilledScore: null,
        tier: 'skim',
        selectionReason: null,
        url: 'https://example.com/article',
        sourceType: 'rss',
        sourceName: 'Engineering Feed',
        tags,
      },
      onClose: () => undefined,
    }));

    expect(html).toContain(message);
    expect(html).toContain('#ai');
    expect(html).not.toContain('evidence_feed_excerpt');
    expect(html).not.toContain('同步时临时读取原文生成摘要和评分');
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

  it('shows the Zread action for repository rows without a stored content kind', () => {
    const html = renderToStaticMarkup(createElement(RadarPreviewPanel, {
      detail: {
        id: '44444444-4444-4444-8444-444444444444',
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
        originalKind: null,
        tags: [],
        publishedAt: null,
      },
      onClose: () => undefined,
    }));

    expect(html).toContain('打开 Zread');
    expect(html).toContain('https://zread.ai/microsoft/markitdown');
  });
});
