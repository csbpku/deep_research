/** Learning self-checks age on their own clock.
 *
 * A judgement is a claim about the world and goes stale when the world may
 * have moved; a self-check is a memory and goes stale when the learner has
 * had time to forget. Sharing one threshold made two-week-old cards look
 * abandoned.
 */
export const LEARNING_REVIEW_STALE_DAYS = 45;

/** How long a mastered answer is trusted before it comes back for review.
 *
 * Repeating the same 30-day interval forever turns review into a treadmill:
 * the reader proves the same fact every month. Each successful retirement
 * doubles the wait, capped so "learned" still means "checked this year".
 */
export const LEARNING_MASTERY_INTERVAL_DAYS = 30;
export const LEARNING_MASTERY_INTERVAL_CAP_DAYS = 180;

export function learningMasteryIntervalDays(masteryCount: number): number {
  // masteryCount == 1 means the first retirement, which waits the base
  // interval; each later retirement doubles it.
  const count = Math.max(0, Math.floor(masteryCount) - 1);
  return Math.min(LEARNING_MASTERY_INTERVAL_DAYS * 2 ** count, LEARNING_MASTERY_INTERVAL_CAP_DAYS);
}

/** Whether the oldest unanswered self-check is older than the policy allows. */
export function isLearningReviewStale(
  oldest: Date | string | null | undefined,
  now: Date = new Date(),
  days: number = LEARNING_REVIEW_STALE_DAYS,
): boolean {
  if (!oldest) return false;
  const value = oldest instanceof Date ? oldest : new Date(oldest);
  if (Number.isNaN(value.getTime())) return false;
  return now.getTime() - value.getTime() >= days * 86_400_000;
}

/** A mastered answer returns after the interval; null means "not mastered". */
export function nextLearningReviewAt(
  masteredAt: Date | string | null | undefined,
  days: number = LEARNING_MASTERY_INTERVAL_DAYS,
  masteryCount = 0,
): Date | null {
  if (!masteredAt) return null;
  const value = masteredAt instanceof Date ? masteredAt : new Date(masteredAt);
  if (Number.isNaN(value.getTime())) return null;
  const interval = days === LEARNING_MASTERY_INTERVAL_DAYS ? learningMasteryIntervalDays(masteryCount) : days;
  return new Date(value.getTime() + interval * 86_400_000);
}

export function isLearningReviewDue(
  masteredAt: Date | string | null | undefined,
  now: Date = new Date(),
  days: number = LEARNING_MASTERY_INTERVAL_DAYS,
  masteryCount = 0,
): boolean {
  const next = nextLearningReviewAt(masteredAt, days, masteryCount);
  return next !== null && next.getTime() <= now.getTime();
}
