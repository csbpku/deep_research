import { describe, expect, it, vi } from 'vitest';
import { getReviewQueueCounts } from './review-queue-count';

describe('review queue count', () => {
  it('counts articles, not questions, so the badge matches the queue page', async () => {
    const count = vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(1);
    const findMany = vi.fn().mockResolvedValue([{ researchId: 'a' }, { researchId: 'b' }]);
    const db = { research: { count }, learningSelfCheck: { findMany } } as never;

    const now = new Date('2026-11-17T00:00:00Z');
    const result = await getReviewQueueCounts(db, 'user-1', now);

    expect(result).toEqual({ judgementDue: 4, judgementOverdue: 1, learningReview: 2, total: 6 });
    expect(count).toHaveBeenNthCalledWith(1, {
      where: {
        authorId: 'user-1',
        type: 'knowledge',
        status: 'published',
        judgement: { not: null },
        judgementReviewAt: { lte: now },
      },
    });
    expect(count).toHaveBeenNthCalledWith(2, {
      where: {
        authorId: 'user-1',
        type: 'knowledge',
        status: 'published',
        judgement: { not: null },
        judgementReviewAt: { lte: new Date(now.getTime() - 180 * 86_400_000) },
      },
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', rating: { in: ['unsure', 'missed'] } },
      distinct: ['researchId'],
      select: { researchId: true },
    });
  });
});
