import { describe, expect, it } from 'vitest';
import { DEFAULT_JUDGEMENT_REVIEW_DAYS, JUDGEMENT_REVIEW_PRESETS, reviewDateFromNow } from './research-review-policy';

describe('research review policy', () => {
  it('defaults to 90 days and offers it as a preset', () => {
    expect(DEFAULT_JUDGEMENT_REVIEW_DAYS).toBe(90);
    expect(JUDGEMENT_REVIEW_PRESETS).toContain(DEFAULT_JUDGEMENT_REVIEW_DAYS);
  });

  it('formats a local calendar date', () => {
    expect(reviewDateFromNow(30, new Date('2026-11-18T12:00:00'))).toBe('2026-12-18');
  });
});
