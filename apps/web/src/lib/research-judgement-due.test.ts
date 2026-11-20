import { describe, expect, it } from 'vitest';
import { judgementDueSummary } from './research-judgement-due';

const NOW = new Date('2026-11-17T00:00:00Z');

describe('judgement due summary', () => {
  it('reports days overdue for a claim whose review date has passed', () => {
    const summary = judgementDueSummary({
      id: 'r1', judgement: 'a claim', judgementConfidence: 'medium',
      judgementScope: 'scope', judgementReviewAt: new Date('2026-11-10T00:00:00Z'),
    }, NOW);
    expect(summary).toEqual({ due: true, daysOverdue: 7 });
  });

  it('is not due in the future', () => {
    expect(judgementDueSummary({
      id: 'r2', judgement: 'a claim', judgementConfidence: 'low',
      judgementScope: 'scope', judgementReviewAt: new Date('2027-01-01T00:00:00Z'),
    }, NOW)).toEqual({ due: false, daysOverdue: null });
  });

  it('ignores cards without a judgement or review date', () => {
    expect(judgementDueSummary({ id: 'r3', judgement: null, judgementConfidence: null, judgementScope: null, judgementReviewAt: null }, NOW))
      .toEqual({ due: false, daysOverdue: null });
  });
});
