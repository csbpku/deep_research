/** Order articles that still have open self-check questions.
 *
 * Missed answers come before unsure ones; within a bucket the article whose
 * last rating is oldest comes first, so a stale weak spot is not buried by a
 * fresh one. Ties fall back to id for stable pagination.
 */
export interface ReviewPriorityItem {
  id: string;
  updatedAt: Date | string;
  learningSelfChecks: { rating: string; updatedAt: Date | string; masteredAt?: Date | string | null }[];
}

function time(value: Date | string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function rankResearchForReview<T extends ReviewPriorityItem>(items: T[]): T[] {
  const weight = (item: T): [number, number, number, string] => {
    const missed = item.learningSelfChecks.filter(check => check.rating === 'missed').length;
    const unsure = item.learningSelfChecks.filter(check => check.rating === 'unsure').length;
    const due = item.learningSelfChecks.filter(check => check.rating !== 'got_it' || check.masteredAt !== undefined);
    const oldest = due.length > 0
      ? Math.min(...due.map(check => time(check.updatedAt)))
      : time(item.updatedAt);
    return [-missed, -unsure, Number.isFinite(oldest) ? oldest : time(item.updatedAt), item.id];
  };
  return [...items].sort((left, right) => {
    const a = weight(left);
    const b = weight(right);
    for (let index = 0; index < 3; index++) {
      if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    }
    return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0;
  });
}
