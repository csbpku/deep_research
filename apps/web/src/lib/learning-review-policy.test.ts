import { describe, expect, it } from 'vitest';
import { LEARNING_REVIEW_STALE_DAYS, isLearningReviewStale, isLearningReviewDue, nextLearningReviewAt } from './learning-review-policy';
import { STALENESS_THRESHOLDS } from './search/staleness-policy';

describe('learning review policy', () => {
  it('does not borrow the judgement staleness threshold', () => {
    expect(LEARNING_REVIEW_STALE_DAYS).toBe(45);
    expect(LEARNING_REVIEW_STALE_DAYS).toBeGreaterThan(STALENESS_THRESHOLDS.aged);
  });
});

describe('isLearningReviewStale', () => {
  const now = new Date('2026-11-18T00:00:00Z');
  it('only flags checks older than the learning policy', () => {
    expect(isLearningReviewStale('2026-10-01T00:00:00Z', now)).toBe(true);
    expect(isLearningReviewStale('2026-11-10T00:00:00Z', now)).toBe(false);
    expect(isLearningReviewStale(null, now)).toBe(false);
  });
});

describe('mastery interval', () => {
  const now = new Date('2026-11-18T00:00:00Z');
  it('brings a mastered answer back after 30 days', () => {
    expect(isLearningReviewDue('2026-10-01T00:00:00Z', now)).toBe(true);
    expect(isLearningReviewDue('2026-11-01T00:00:00Z', now)).toBe(false);
    expect(nextLearningReviewAt('2026-11-01T00:00:00Z')?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(nextLearningReviewAt(null)).toBeNull();
  });
});
