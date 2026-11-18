import type { PrismaClient } from '@prisma/client';
import { STALENESS_THRESHOLDS } from './search/staleness-policy';
import { LEARNING_REVIEW_STALE_DAYS } from './learning-review-policy';

/** How many items are waiting in the "待处理" queue for this user.
 *
 * Counts articles, not individual questions: the badge links to a page that
 * lists one row per article, and a badge that says 5 while the page shows 1
 * row would make the user distrust both.
 *
 * The `*Overdue` fields are subsets of their parent counts: they answer
 * "what has been waiting too long", not "what is waiting".
 */
export interface ReviewQueueCounts {
  judgementDue: number;
  judgementOverdue: number;
  learningReview: number;
  learningStale: number;
  total: number;
}

type ReviewQueueDb = Pick<PrismaClient, 'research' | 'learningSelfCheck'>;

export async function getReviewQueueCounts(db: ReviewQueueDb, userId: string, now = new Date()): Promise<ReviewQueueCounts> {
  const abandonedBefore = new Date(now.getTime() - STALENESS_THRESHOLDS.abandoned * 86_400_000);
  const learningStaleBefore = new Date(now.getTime() - LEARNING_REVIEW_STALE_DAYS * 86_400_000);
  const [judgementDue, judgementOverdue, weakChecks] = await Promise.all([
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
    db.learningSelfCheck.groupBy({
      by: ['researchId'],
      where: { userId, rating: { in: ['unsure', 'missed'] } },
      _min: { updatedAt: true },
    }),
  ]);
  const learningStale = weakChecks.filter(
    (check) => (check._min.updatedAt?.getTime() ?? now.getTime()) <= learningStaleBefore.getTime(),
  ).length;
  return {
    judgementDue,
    judgementOverdue,
    learningReview: weakChecks.length,
    learningStale,
    total: judgementDue + weakChecks.length,
  };
}
