/** How long a freshly published judgement stays credible before review. */
export const DEFAULT_JUDGEMENT_REVIEW_DAYS = 90;

/** Quick choices offered when reaffirming an expired judgement. */
export const JUDGEMENT_REVIEW_PRESETS = [30, DEFAULT_JUDGEMENT_REVIEW_DAYS, 180] as const;

/** Local-calendar date string N days from `now`, safe for <input type="date">. */
export function reviewDateFromNow(days: number, now: Date = new Date()): string {
  const next = new Date(now);
  next.setDate(next.getDate() + days);
  const month = String(next.getMonth() + 1).padStart(2, '0');
  const day = String(next.getDate()).padStart(2, '0');
  return `${next.getFullYear()}-${month}-${day}`;
}
