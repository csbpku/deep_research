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
      where: { userId: 'user-1', rating: { in: ['unsure', 'missed'] }, research: { status: 'published' } },
      _min: { firstMissedAt: true, updatedAt: true },
    });
  });

  it('excludes archived and unpublished articles while keeping their self-check records', async () => {
    const rows = ['published', 'archived', 'draft'].map((status, index) => ({
      researchId: String(index), status,
      _min: { firstMissedAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z') },
    }));
    const groupBy = vi.fn(async ({ where }: { where: { research?: { status: string } } }) => (
      rows.filter(row => !where.research || row.status === where.research.status)
    ));
    const db = { research: { count: vi.fn().mockResolvedValue(0) }, learningSelfCheck: { groupBy } } as never;
    expect(await getReviewQueueCounts(db, 'user-1', new Date('2026-11-24T00:00:00Z'))).toEqual({
      judgementDue: 0, judgementOverdue: 0, learningReview: 1, learningStale: 1, total: 1,
    });
    expect(rows).toHaveLength(3);
  });
});
