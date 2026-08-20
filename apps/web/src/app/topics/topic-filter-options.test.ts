import { describe, expect, it } from 'vitest';

import { parseTopicFilter } from './topic-filter-options';

describe('parseTopicFilter', () => {
  it.each(['all', 'hot', 'warming', 'emerging', 'followed'])('accepts the %s filter', (filter) => {
    expect(parseTopicFilter(filter)).toBe(filter);
  });

  it('falls back to all for missing or invalid filters', () => {
    expect(parseTopicFilter(undefined)).toBe('all');
    expect(parseTopicFilter('unknown')).toBe('all');
  });
});
