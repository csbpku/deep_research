import { describe, expect, it } from 'vitest';
import { staleDays, staleness } from './judgement-age';

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

describe('staleness', () => {
  const now = new Date('2026-11-18T00:00:00Z');
  it('grades by elapsed days', () => {
    expect(staleness('2026-11-18T00:00:00Z', now)).toBe('fresh');
    expect(staleness('2026-11-10T00:00:00Z', now)).toBe('aged');
    expect(staleness('2026-09-01T00:00:00Z', now)).toBe('stale');
    expect(staleness('2025-01-01T00:00:00Z', now)).toBe('abandoned');
  });
});
