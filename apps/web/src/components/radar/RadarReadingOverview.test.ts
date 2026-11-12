import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../domain/BackToSearchButton', () => ({
  BackToSearchButton: () => createElement('button', null, '返回'),
}));

import { RadarExternalReadingLanding } from './RadarExternalReadingLanding';
import { RadarPreviewPanel } from './RadarPreviewPanel';
import type { ExternalReadingDetail } from './radar-reading-detail';

const detail: ExternalReadingDetail = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'One shared reading overview',
  excerpt: 'A longer source excerpt that does not repeat the interpretation.',
  interpretation: '一句话判断：这是同一份阅读概览。',
  scoreReason: null,
  distilledScore: {
    total: 82,
    tier: 'deep_read',
    tierScore: 82,
    rankingScore: 77,
    qualityScore: 82,
    profile: 'engineering',
    isDefault: false,
    dimensions: {
      informationGain: 3,
      analysisDepth: 3,
      actionability: 2,
      factualReliability: 3,
      currentApplicability: 2,
      expressionQuality: 3,
      audienceFit: 2,
    },
    weakPoint: '',
    veto: null,
    riskFlags: [],
    version: '1',
  },
  tier: 'deep_read',
  selectionReason: 'It contains a reusable implementation pattern.',
  url: 'https://example.com/article',
  sourceType: 'rss',
  sourceName: 'Engineering Feed',
  tags: ['ai', 'architecture'],
  publishedAt: '2026-09-20T00:00:00.000Z',
  isAuthenticated: true,
  feedbackCounts: {
    read: 2,
    later: 1,
    pilot: 0,
    inaccurate: 0,
    favorite: 3,
    useful: 0,
    used: 0,
    suggest_research: 0,
  },
  myFeedbacks: ['read', 'favorite'],
  highlights: {
    summary: 'A shared summary',
    highlights: ['A key point that both surfaces must show.'],
    keyQuote: null,
  },
};

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

function panelHtml(): string {
  return renderToStaticMarkup(createElement(RadarPreviewPanel, {
    detail,
    onClose: () => undefined,
  }));
}

function pageHtml(): string {
  return renderToStaticMarkup(createElement(RadarExternalReadingLanding, { detail }));
}

describe('RadarReadingOverview', () => {
  it.each([
    ['panel', panelHtml],
    ['page', pageHtml],
  ])('renders one primary CTA and the shared fields on the %s surface', (_surface, render) => {
    const html = render();

    // P0-5: exactly one primary CTA per surface. The evidence notice also
    // mentions 打开原文, so count the marked element rather than the phrase.
    expect(count(html, 'data-radar-primary-cta="true"')).toBe(1);
    expect(html).toMatch(/<a[^>]*data-radar-primary-cta="true"[^>]*>[\s\S]*?打开原文/);

    // Same overview contract on both surfaces.
    expect(html).toContain('data-radar-overview=');
    expect(html).toContain('为什么值得看');
    expect(html).toContain('一句话判断：这是同一份阅读概览。');
    expect(html).toContain('A key point that both surfaces must show.');
    expect(html).toContain('精读');
    expect(html).toContain('#ai');
    expect(html).toContain('#architecture');
    expect(html).toContain('雷达候选反馈');
    expect(html).toContain('写笔记');
    expect(html).toContain('用 Reader 阅读');
    expect(html).toContain('查看评分依据');
    expect(html).toContain('摘要与评分基于同步时可用的资料；请打开原文或 Reader 核对');
  });

  it('renders the Reader entry once per surface', () => {
    for (const html of [panelHtml(), pageHtml()]) {
      expect(count(html, 'data-reader-launch-source=')).toBe(1);
      expect(count(html, '>用 Reader 阅读<')).toBe(1);
    }
  });

  it('keeps the single primary CTA when the source is a GitHub repository', () => {
    const repoDetail: ExternalReadingDetail = {
      ...detail,
      url: 'https://github.com/microsoft/markitdown',
      sourceType: 'github',
      sourceName: 'GitHub',
      originalKind: 'github_repo',
    };

    for (const html of [
      renderToStaticMarkup(createElement(RadarPreviewPanel, { detail: repoDetail, onClose: () => undefined })),
      renderToStaticMarkup(createElement(RadarExternalReadingLanding, { detail: repoDetail })),
    ]) {
      expect(count(html, 'data-radar-primary-cta="true"')).toBe(1);
      expect(html).toMatch(/<a[^>]*data-radar-primary-cta="true"[^>]*>[\s\S]*?打开 GitHub/);
      expect(count(html, '打开 Zread')).toBe(1);
    }
  });
});
