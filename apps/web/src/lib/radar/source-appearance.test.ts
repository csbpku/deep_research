import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { RadarSourceChip } from '@/components/radar/RadarSourceChip';
import { radarSourceAppearance } from './source-appearance';

describe('radar source appearance', () => {
  it.each([
    ['github_release', 'github'], ['github_repo', 'github'], ['rss', 'articles'],
    ['vendor_news', 'articles'], ['wechat', 'articles'], ['hackernews', 'community'],
    ['producthunt', 'community'], ['reddit', 'community'], ['arxiv', 'research'],
    ['huggingface_papers', 'research'], ['web_share', 'shared'],
  ])('keeps %s in its existing %s source family', (source, category) => {
    expect(radarSourceAppearance(source)).toEqual({
      category, color: `var(--dr-color-source-${category})`,
      background: `var(--dr-color-source-${category}-container)`,
    });
  });

  it.each(['github', 'articles', 'community', 'research', 'shared'])('uses the same identity for the %s group and its source chips', category => {
    expect(radarSourceAppearance(category).category).toBe(category);
  });

  it('recognizes the existing RSS-backed Hacker News source', () => {
    expect(radarSourceAppearance('rss', 'Hacker News').category).toBe('community');
  });

  it('shows a source-colored marker while retaining the readable source label', () => {
    const html = render(h(RadarSourceChip, { sourceType: 'arxiv' }));
    expect(html).toContain('data-radar-source="research"');
    expect(html).toContain('aria-label="arXiv 论文"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('arXiv');
  });

  it.each([null, undefined, 'new-unknown-source'])('keeps unknown source %s neutral', source => {
    expect(radarSourceAppearance(source)).toEqual({
      category: 'other', color: 'var(--dr-color-text-secondary)', background: 'var(--dr-color-surface-container)',
    });
  });
});
