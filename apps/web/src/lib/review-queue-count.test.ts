import { describe, expect, it, vi } from 'vitest';
import { getReviewQueueCounts } from './review-queue-count';

describe('review queue count', () => {
  it('counts only the current user\'s due judgements and distinct learning reviews', async () => {
    const count = vi.fn().mockResolvedValue(2);
    const findMany = vi.fn().mockResolvedValue([{ researchId: 'a' }, { researchId: 'b' }, { researchId: 'c' }]);
    const db = { research: { count }, learningSelfCheck: { findMany } } as never;

    const result = await getReviewQueueCounts(db, 'user-1', new Date('2026-11-17T00:00:00Z'));

    expect(result).toEqual({ judgementDue: 2, learningReview: 3, total: 5 });
    expect(count).toHaveBeenCalledWith({
      where: {
        authorId: 'user-1',
        type: 'knowledge',
        status: 'published',
        judgement: { not: null },
        judgementReviewAt: { lte: new Date('2026-11-17T00:00:00Z') },
      },
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', rating: { in: ['unsure', 'missed'] } },
      distinct: ['researchId'],
      select: { researchId: true },
    });
  });
});
