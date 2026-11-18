import { describe, expect, it } from 'vitest';
import { staleDays } from './judgement-age';

describe('staleDays', () => {
  const now = new Date('2026-11-18T00:00:00Z');

  it('counts whole days past the review date', () => {
    expect(staleDays('2026-11-15T00:00:00Z', now)).toBe(3);
  });

  it('returns 0 before the review date and for missing values', () => {
    expect(staleDays('2026-12-01T00:00:00Z', now)).toBe(0);
    expect(staleDays(null, now)).toBe(0);
  });
});
