import type { PrismaClient } from '@prisma/client';
import { STALENESS_THRESHOLDS } from './search/staleness-policy';

/** How many items are waiting in the "待处理" queue for this user.
 *
 * Counts articles, not individual questions: the badge links to a page that
 * lists one row per article, and a badge that says 5 while the page shows 1
 * row would make the user distrust both.
 *
 * `judgementOverdue` is a subset of `judgementDue`: an expired judgement is
 * already waiting, but one left untouched for months deserves its own number.
 */
export interface ReviewQueueCounts {
  judgementDue: number;
  judgementOverdue: number;
  learningReview: number;
  total: number;
}

type ReviewQueueDb = Pick<PrismaClient, 'research' | 'learningSelfCheck'>;

export async function getReviewQueueCounts(db: ReviewQueueDb, userId: string, now = new Date()): Promise<ReviewQueueCounts> {
  const abandonedBefore = new Date(now.getTime() - STALENESS_THRESHOLDS.abandoned * 86_400_000);
  const [judgementDue, judgementOverdue, learningArticles] = await Promise.all([
    db.research.count({
      where: {
        authorId: userId,
        type: 'knowledge',
        status: 'published',
        judgement: { not: null },
        judgementReviewAt: { lte: now },
      },
    }),
    db.research.count({
      where: {
        authorId: userId,
        type: 'knowledge',
        status: 'published',
        judgement: { not: null },
        judgementReviewAt: { lte: abandonedBefore },
      },
    }),
    db.learningSelfCheck.findMany({
      where: { userId, rating: { in: ['unsure', 'missed'] } },
      distinct: ['researchId'],
      select: { researchId: true },
    }),
  ]);
  return {
    judgementDue,
    judgementOverdue,
    learningReview: learningArticles.length,
    total: judgementDue + learningArticles.length,
  };
}
