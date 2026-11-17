import { describe, expect, it, vi } from 'vitest';
import { getReviewQueueCounts } from './review-queue-count';

describe('review queue count', () => {
  it('counts articles, not questions, so the badge matches the queue page', async () => {
    const count = vi.fn().mockResolvedValue(2);
    const findMany = vi.fn().mockResolvedValue([{ researchId: 'a' }, { researchId: 'b' }]);
    const db = { research: { count }, learningSelfCheck: { findMany } } as never;

    const now = new Date('2026-11-17T00:00:00Z');
    const result = await getReviewQueueCounts(db, 'user-1', now);

    expect(result).toEqual({ judgementDue: 2, learningReview: 2, total: 4 });
    expect(count).toHaveBeenCalledWith({
      where: {
        authorId: 'user-1',
        type: 'knowledge',
        status: 'published',
        judgement: { not: null },
        judgementReviewAt: { lte: now },
      },
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', rating: { in: ['unsure', 'missed'] } },
      distinct: ['researchId'],
      select: { researchId: true },
    });
  });
});
