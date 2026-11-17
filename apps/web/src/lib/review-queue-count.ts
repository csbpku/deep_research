import type { PrismaClient } from '@prisma/client';

/** How many items are waiting in the "待处理" queue for this user.
 *
 * Counts only what the user can actually act on:
 *  - published knowledge cards they authored whose judgement review date passed;
 *  - learning paths where their own self-check says unsure/missed.
 *
 * Kept as one query pair so the badge and the /review page cannot disagree.
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
    db.learningSelfCheck.findMany({
      where: { userId, rating: { in: ['unsure', 'missed'] } },
      distinct: ['researchId'],
      select: { researchId: true },
    }).then(rows => rows.length),
  ]);
  return { judgementDue, learningReview, total: judgementDue + learningReview };
}
