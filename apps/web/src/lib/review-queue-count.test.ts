import { describe, expect, it, vi } from 'vitest';
import { getReviewQueueCounts } from './review-queue-count';

describe('review queue count', () => {
  it('counts articles, and separates items waiting too long', async () => {
    const count = vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(1);
    const groupBy = vi.fn().mockResolvedValue([
      // Re-rating refreshed updatedAt, but firstMissedAt still says 50 days.
      { researchId: 'a', _min: { firstMissedAt: new Date('2026-09-28T00:00:00Z'), updatedAt: new Date('2026-11-16T00:00:00Z') } },
      { researchId: 'b', _min: { firstMissedAt: new Date('2026-11-10T00:00:00Z'), updatedAt: new Date('2026-11-10T00:00:00Z') } },
    ]);
    const findMany = vi.fn().mockResolvedValue([
      // Mastered 40 days ago, first retirement: 30-day interval, so due.
      { researchId: 'c', masteredAt: new Date('2026-10-08T00:00:00Z'), masteryCount: 1 },
      // Mastered 40 days ago, second retirement: 60-day interval, not due.
      { researchId: 'd', masteredAt: new Date('2026-10-08T00:00:00Z'), masteryCount: 2 },
    ]);
    const db = { research: { count }, learningSelfCheck: { groupBy, findMany } } as never;

    const now = new Date('2026-11-17T00:00:00Z');
    const result = await getReviewQueueCounts(db, 'user-1', now);

    expect(result).toEqual({
      judgementDue: 4,
      judgementOverdue: 1,
      learningReview: 3,
      learningStale: 1,
      total: 7,
    });
    expect(groupBy).toHaveBeenCalledWith({
      by: ['researchId'],
      where: { userId: 'user-1', rating: { in: ['unsure', 'missed'] } },
      _min: { firstMissedAt: true, updatedAt: true },
    });
  });
});
