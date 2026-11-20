import { describe, expect, it } from 'vitest';
import { rankResearchForReview } from './research-review-priority';

const at = (iso: string) => new Date(iso);

describe('rankResearchForReview', () => {
  it('puts missed before unsure and older ratings before newer ones', () => {
    const ranked = rankResearchForReview([
      { id: 'new-unsure', updatedAt: at('2026-11-10'), learningSelfChecks: [{ rating: 'unsure', updatedAt: at('2026-11-10') }] },
      { id: 'old-missed', updatedAt: at('2026-11-01'), learningSelfChecks: [{ rating: 'missed', updatedAt: at('2026-11-01') }] },
      { id: 'old-unsure', updatedAt: at('2026-10-01'), learningSelfChecks: [{ rating: 'unsure', updatedAt: at('2026-10-01') }] },
    ]);
    expect(ranked.map(item => item.id)).toEqual(['old-missed', 'old-unsure', 'new-unsure']);
  });

  it('breaks ties by id', () => {
    const ranked = rankResearchForReview([
      { id: 'b', updatedAt: at('2026-11-01'), learningSelfChecks: [{ rating: 'missed', updatedAt: at('2026-11-01') }] },
      { id: 'a', updatedAt: at('2026-11-01'), learningSelfChecks: [{ rating: 'missed', updatedAt: at('2026-11-01') }] },
    ]);
    expect(ranked.map(item => item.id)).toEqual(['a', 'b']);
  });
});
