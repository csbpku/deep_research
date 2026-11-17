import { describe, expect, it, vi } from 'vitest';
import { getReviewQueueCounts } from './review-queue-count';

describe('review queue count', () => {
  it('counts due judgements plus every unsure/missed question', async () => {
    const count = vi.fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(5);
    const db = { research: { count }, learningSelfCheck: { count } } as never;

    const result = await getReviewQueueCounts(db, 'user-1', new Date('2026-11-17T00:00:00Z'));

    expect(count).toHaveBeenNthCalledWith(1, {
      where: {
        authorId: 'user-1',
        type: 'knowledge',
        status: 'published',
        judgement: { not: null },
        judgementReviewAt: { lte: new Date('2026-11-17T00:00:00Z') },
      },
    });
    expect(count).toHaveBeenNthCalledWith(2, {
      where: { userId: 'user-1', rating: { in: ['unsure', 'missed'] } },
    });
    expect(result).toEqual({ judgementDue: 2, learningReview: 5, total: 7 });
  });
});
