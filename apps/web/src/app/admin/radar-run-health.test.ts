import { describe, expect, it } from 'vitest';
import { consecutiveEmptyRuns } from './radar-run-health';

describe('consecutiveEmptyRuns', () => {
  it('counts recent completed empty RSS runs per source and stops at the first nonempty run', () => {
    const runs = [
      { sourceId: 'a', sourceType: 'rss', status: 'completed', totalFetched: 0 },
      { sourceId: 'b', sourceType: 'vendor_news', status: 'completed', totalFetched: 0 },
      { sourceId: 'a', sourceType: 'rss', status: 'completed', totalFetched: 0 },
      { sourceId: 'a', sourceType: 'rss', status: 'completed', totalFetched: 10 },
      { sourceId: 'a', sourceType: 'rss', status: 'completed', totalFetched: 0 },
    ];
    expect(consecutiveEmptyRuns(runs).get('a')).toBe(2);
    expect(consecutiveEmptyRuns(runs).has('b')).toBe(false);
  });

  it('does not claim an empty streak through a failed or running attempt', () => {
    const runs = [
      { sourceId: 'a', sourceType: 'rss', status: 'running', totalFetched: 0 },
      { sourceId: 'a', sourceType: 'rss', status: 'completed', totalFetched: 0 },
    ];
    expect(consecutiveEmptyRuns(runs).get('a')).toBe(0);
  });
});
