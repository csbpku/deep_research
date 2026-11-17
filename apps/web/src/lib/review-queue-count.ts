import type { PrismaClient } from '@prisma/client';

/** How many items are waiting in the "待处理" queue for this user.
 *
 * Counts articles, not individual questions: the badge links to a page that
 * lists one row per article, and a badge that says 5 while the page shows 1
 * row would make the user distrust both.
 */
export interface ReviewQueueCounts {
  judgementDue: number;
  learningReview: number;
  total: number;
}

type ReviewQueueDb = Pick<PrismaClient, 'research' | 'learningSelfCheck'>;

export async function getReviewQueueCounts(db: ReviewQueueDb, userId: string, now = new Date()): Promise<ReviewQueueCounts> {
  const [judgementDue, learningArticles] = await Promise.all([
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
    }),
  ]);
  return { judgementDue, learningReview: learningArticles.length, total: judgementDue + learningArticles.length };
}
