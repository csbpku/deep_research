import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../domain/BackToSearchButton', () => ({
  BackToSearchButton: () => createElement('button', null, '返回'),
}));

import { externalReaderUrl, RadarExternalReadingLanding } from './RadarExternalReadingLanding';
import { zreadRepositoryUrl } from './radar-repository';

describe('RadarExternalReadingLanding', () => {
  it('marks the external URL so the installed Reader can recognize radar context', () => {
    const url = new URL(externalReaderUrl(
      'https://example.com/article?lang=en#architecture',
      '11111111-1111-4111-8111-111111111111',
    ));

    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.searchParams.get('deep-research-source')).toBe('radar');
    expect(url.searchParams.get('deep-research-summary')).toBe('11111111-1111-4111-8111-111111111111');
    expect(url.hash).toBe('#architecture');
  });

  it('passes the current platform origin without changing the source URL shape', () => {
    const url = new URL(externalReaderUrl(
      'https://example.com/article?lang=en#architecture',
      'summary-id',
      'https://reader.example.com/some/path',
    ));

    expect(url.searchParams.get('deep-research-platform')).toBe('https://reader.example.com');
    expect(url.searchParams.get('deep-research-source')).toBe('radar');
    expect(url.hash).toBe('#architecture');
  });

  it('renders the decision path without exposing the full source body', () => {
    const html = renderToStaticMarkup(createElement(RadarExternalReadingLanding, {
      detail: {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'A technical article',
        excerpt: 'A bounded summary.',
        interpretation: 'A concise AI interpretation.',
        scoreReason: null,
        distilledScore: null,
        tier: 'skim',
        selectionReason: 'It has a useful implementation signal.',
        url: 'https://example.com/article',
        sourceType: 'rss',
        sourceName: 'Engineering Feed',
      },
    }));

    expect(html).toContain('安装 Reader');
    expect(html).toContain('/reading/install');
    expect(html).toContain('deep-research-source=radar');
    expect(html).toContain('AI 摘要');
    expect(html).toContain('A concise AI interpretation.');
    expect(html).toContain('为什么值得看');
    expect(html).toContain('只有你明确保存时才会上传内容');
    expect(html).not.toContain('打开原文，核对上下文');
    expect(html).not.toContain('评分依据');
    expect(html).not.toContain('把阅读交回来源页面');
    expect(html).not.toContain('独立模式');
    expect(html).not.toContain('原文正文');
  });

  it('keeps the rating secondary to the reading summary', () => {
    const html = renderToStaticMarkup(createElement(RadarExternalReadingLanding, {
      detail: {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'A technical article',
        excerpt: 'A longer source excerpt that gives the reader more context.',
        interpretation: 'A concise AI interpretation.',
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
        selectionReason: null,
        url: 'https://example.com/article',
        sourceType: 'rss',
        sourceName: 'Engineering Feed',
      },
    }));

    expect(html).toContain('查看评分依据');
    expect(html).toContain('A longer source excerpt');
    expect(html).not.toContain('阅读建议');
    expect(html).not.toContain('排序参考');
    expect(html).not.toContain('查看评分细节');
  });

  it('does not decorate unsupported protocols', () => {
    expect(externalReaderUrl('javascript:alert(1)', 'summary-id')).toBe('javascript:alert(1)');
  });

  it('derives a Zread URL only for a GitHub repository root', () => {
    expect(zreadRepositoryUrl('https://github.com/microsoft/markitdown')).toBe(
      'https://zread.ai/microsoft/markitdown',
    );
    expect(zreadRepositoryUrl('https://github.com/microsoft/markitdown/issues/1')).toBeNull();
    expect(zreadRepositoryUrl('https://example.com/microsoft/markitdown')).toBeNull();
  });

  it('offers separate GitHub and Zread actions for repository radar items', () => {
    const html = renderToStaticMarkup(createElement(RadarExternalReadingLanding, {
      detail: {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'microsoft/markitdown',
        excerpt: 'Repository summary.',
        interpretation: 'A concise AI interpretation.',
        scoreReason: null,
        distilledScore: null,
        tier: 'deep_read',
        selectionReason: null,
        url: 'https://github.com/microsoft/markitdown',
        sourceType: 'github',
        sourceName: 'GitHub',
        originalKind: 'github_repo',
      },
    }));

    expect(html).toContain('打开 GitHub');
    expect(html).toContain('打开 Zread');
    expect(html).toContain('https://zread.ai/microsoft/markitdown');
    expect(html).not.toContain('>打开原文<');
  });
});
