/** Learning self-checks age on their own clock.
 *
 * A judgement is a claim about the world and goes stale when the world may
 * have moved; a self-check is a memory and goes stale when the learner has
 * had time to forget. Sharing one threshold made two-week-old cards look
 * abandoned.
 */
export const LEARNING_REVIEW_STALE_DAYS = 45;

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
