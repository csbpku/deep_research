import { STALENESS_THRESHOLDS } from './staleness-policy';

/** Whole days a judgement has been past its review date; 0 when not due. */
export function staleDays(reviewAt: Date | string | null | undefined, now: Date = new Date()): number {
  if (!reviewAt) return 0;
  const review = reviewAt instanceof Date ? reviewAt : new Date(reviewAt);
  if (Number.isNaN(review.getTime())) return 0;
  const diff = now.getTime() - review.getTime();
  return diff <= 0 ? 0 : Math.floor(diff / 86_400_000);
}

export type Staleness = 'fresh' | 'aged' | 'stale' | 'abandoned';

/** Grade a judgement by how far past its review date it is. */
export function staleness(reviewAt: Date | string | null | undefined, now: Date = new Date()): Staleness {
  const days = staleDays(reviewAt, now);
  if (days === 0) return 'fresh';
  if (days < STALENESS_THRESHOLDS.aged) return 'aged';
  if (days < STALENESS_THRESHOLDS.abandoned) return 'stale';
  return 'abandoned';
}
