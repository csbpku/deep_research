import { describe, expect, it } from 'vitest';

import { formatRadarContentKind, toRadarSourceCategory } from './source-labels';

describe('formatRadarContentKind', () => {
  it('separates a GitHub discovery source from repository content', () => {
    expect(formatRadarContentKind('github_repo', 'github')).toEqual({
      short: '仓库',
      full: 'GitHub 仓库',
    });
  });

  it('recognizes shared community links by URL', () => {
    expect(formatRadarContentKind(
      'web_share',
      'web',
      'https://www.reddit.com/r/MachineLearning/comments/example/post',
    ).short).toBe('社区讨论');
  });

  it('keeps research papers distinct from technical articles', () => {
    expect(formatRadarContentKind('arxiv', 'arxiv').short).toBe('研究论文');
    expect(formatRadarContentKind('rss', 'rss').short).toBe('技术文章');
    expect(toRadarSourceCategory('huggingface_papers')).toBe('research');
  });

  it('lets a known article source override the legacy web_share kind', () => {
    expect(formatRadarContentKind('web_share', 'vendor_news', 'https://huggingface.co/blog/example').short)
      .toBe('技术文章');
  });

  it('routes RSS sources named Hacker News to community without moving other RSS feeds', () => {
    expect(toRadarSourceCategory('rss', 'Hacker News Frontpage')).toBe('community');
    expect(toRadarSourceCategory('rss', 'Engineering Weekly')).toBe('articles');
  });
});
