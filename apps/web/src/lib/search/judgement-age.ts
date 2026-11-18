/** Whole days a judgement has been past its review date; 0 when not due. */
export function staleDays(reviewAt: Date | string | null | undefined, now: Date = new Date()): number {
  if (!reviewAt) return 0;
  const review = reviewAt instanceof Date ? reviewAt : new Date(reviewAt);
  if (Number.isNaN(review.getTime())) return 0;
  const diff = now.getTime() - review.getTime();
  return diff <= 0 ? 0 : Math.floor(diff / 86_400_000);
}
