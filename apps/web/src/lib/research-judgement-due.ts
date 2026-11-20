import type { Prisma } from '@prisma/client';

/** A published knowledge card's claim expires: once `judgementReviewAt`
 *  passes, the library should surface it instead of letting a stale judgement
 *  look current. Null rows (older cards, research reports) are not due. */
export interface JudgementDueQuestion {
  id: string;
  judgement?: string | null;
  judgementConfidence?: string | null;
  judgementScope?: string | null;
  judgementReviewAt?: Date | null;
}

export function judgementDueWhere(now = new Date()): Prisma.ResearchWhereInput {
  return {
    type: 'knowledge',
    status: 'published',
    judgement: { not: null },
    judgementReviewAt: { lte: now },
  };
}

export function judgementDueSummary(item: JudgementDueQuestion, now = new Date()): {
  due: boolean;
  daysOverdue: number | null;
} {
  if (!item.judgementReviewAt || !item.judgement) return { due: false, daysOverdue: null };
  const diff = now.getTime() - item.judgementReviewAt.getTime();
  return { due: diff >= 0, daysOverdue: diff >= 0 ? Math.floor(diff / 86_400_000) : null };
}
