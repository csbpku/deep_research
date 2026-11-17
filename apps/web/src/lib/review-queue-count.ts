import type { PrismaClient } from '@prisma/client';

/** How many items are waiting in the "待处理" queue for this user.
 *
 * Counts only what the user can actually act on. Learning items are counted
 * per question, not per article: a path with five missed prompts is five
 * reviews, and hiding that would make the badge lie about the workload.
 */
export interface ReviewQueueCounts {
  judgementDue: number;
  learningReview: number;
  total: number;
}

type ReviewQueueDb = Pick<PrismaClient, 'research' | 'learningSelfCheck'>;

export async function getReviewQueueCounts(db: ReviewQueueDb, userId: string, now = new Date()): Promise<ReviewQueueCounts> {
  const [judgementDue, learningReview] = await Promise.all([
    db.research.count({
      where: {
        authorId: userId,
        type: 'knowledge',
        status: 'published',
        judgement: { not: null },
        judgementReviewAt: { lte: now },
      },
    }),
    db.learningSelfCheck.count({
      where: { userId, rating: { in: ['unsure', 'missed'] } },
    }),
  ]);
  return { judgementDue, learningReview, total: judgementDue + learningReview };
}
