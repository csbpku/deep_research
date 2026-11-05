import { describe, expect, it } from 'vitest';
import { selectRadarHighlights } from './highlights';

function item(id: string, sourceType: string | null, sourceName: string | null, url = `https://example.com/${id}`) {
  return { id, sourceType, sourceName, url };
}

describe('selectRadarHighlights', () => {
  it('covers represented categories and prefers distinct sources within a category', () => {
    const ranked = [
      item('article-a1', 'rss', 'A'),
      item('article-a2', 'rss', 'A'),
      item('article-b1', 'rss', 'B'),
      item('paper-1', 'arxiv', 'arXiv'),
      item('paper-2', 'arxiv', 'arXiv'),
      item('community-1', 'hackernews', 'HN'),
      item('community-2', 'reddit', 'Reddit'),
    ];
    expect(selectRadarHighlights(ranked).map(candidate => candidate.id)).toEqual([
      'article-a1', 'paper-1', 'community-1',
      'article-b1', 'paper-2', 'community-2', 'article-a2',
    ]);
    expect(ranked.map(candidate => candidate.id)).toEqual([
      'article-a1', 'article-a2', 'article-b1', 'paper-1', 'paper-2', 'community-1', 'community-2',
    ]);
  });

  it('uses available articles when only one source exists instead of enforcing a hard quota', () => {
    const ranked = Array.from({ length: 14 }, (_, index) => item(String(index), 'rss', 'A'));
    expect(selectRadarHighlights(ranked).map(candidate => candidate.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index)),
    );
  });

  it('never selects a candidate outside the bounded pool or duplicates an id', () => {
    const ranked = Array.from({ length: 100 }, (_, index) => item(String(index), 'rss', 'A'));
    ranked[1] = ranked[0];
    ranked.push(item('outside-pool', 'arxiv', 'arXiv'));
    const selected = selectRadarHighlights(ranked);
    expect(selected).toHaveLength(10);
    expect(new Set(selected.map(candidate => candidate.id)).size).toBe(10);
    expect(selected.some(candidate => candidate.id === 'outside-pool')).toBe(false);
  });

  it('treats HN Algolia and OpenReview as community and research, respectively', () => {
    const ranked = [
      item('hn1', 'hackernews', 'HN'),
      item('hn2', 'hn_algolia', 'HN search'),
      item('paper1', 'arxiv', 'arXiv'),
      item('paper2', 'openreview', 'OpenReview'),
    ];
    expect(selectRadarHighlights(ranked).map(candidate => candidate.id)).toEqual([
      'hn1', 'paper1', 'hn2', 'paper2',
    ]);
  });

  it('uses the article host when no source name is available', () => {
    const ranked = [
      item('a1', null, null, 'https://a.example/1'),
      item('a2', null, null, 'https://a.example/2'),
      item('b1', null, null, 'https://b.example/1'),
    ];
    expect(selectRadarHighlights(ranked).map(candidate => candidate.id)).toEqual(['a1', 'b1', 'a2']);
    expect(selectRadarHighlights([])).toEqual([]);
  });
});
