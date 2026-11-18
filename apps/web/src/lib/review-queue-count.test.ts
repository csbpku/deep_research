import { describe, expect, it, vi } from 'vitest';
import { getReviewQueueCounts } from './review-queue-count';

describe('review queue count', () => {
  it('counts articles, and separates items waiting too long', async () => {
    const count = vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(1);
    const groupBy = vi.fn().mockResolvedValue([
      { researchId: 'a', _min: { updatedAt: new Date('2026-11-01T00:00:00Z') } },
      { researchId: 'b', _min: { updatedAt: new Date('2026-10-01T00:00:00Z') } },
    ]);
    const db = { research: { count }, learningSelfCheck: { groupBy } } as never;

    const now = new Date('2026-11-17T00:00:00Z');
    const result = await getReviewQueueCounts(db, 'user-1', now);

    expect(result).toEqual({
      judgementDue: 4,
      judgementOverdue: 1,
      learningReview: 2,
      learningStale: 1,
      total: 6,
    });
    expect(groupBy).toHaveBeenCalledWith({
      by: ['researchId'],
      where: { userId: 'user-1', rating: { in: ['unsure', 'missed'] } },
      _min: { updatedAt: true },
    });
  });
});
