import { describe, expect, it } from 'vitest';
import { isRadarSummaryVisible } from './visibility';

const base = {
  source: 'daily', syncRunId: 'r1', shareSource: null, distilledScore: { tier: 'deep_read' },
  distilledTier: 'deep_read', tags: [], enrichmentStatus: 'ready', readerQualityStatus: 'ready',
  contentReviewStatus: 'approved',
};

describe('isRadarSummaryVisible', () => {
  it('shows fully approved deep_read', () => expect(isRadarSummaryVisible(base, false)).toBe(true));
  it('hides unscored for members, not admins', () => {
    const s = { ...base, distilledScore: null };
    expect(isRadarSummaryVisible(s, false)).toBe(false);
    expect(isRadarSummaryVisible(s, true)).toBe(true);
  });
  it('hides noise and unapproved deep_read for members', () => {
    expect(isRadarSummaryVisible({ ...base, distilledTier: 'noise' }, false)).toBe(false);
    expect(isRadarSummaryVisible({ ...base, contentReviewStatus: 'pending' }, false)).toBe(false);
  });
  it('hides non-radar rows', () => {
    expect(isRadarSummaryVisible({ ...base, source: 'user', shareSource: { status: 'pending' } }, true)).toBe(false);
  });
});

import { canSeedChatFromSummary } from './visibility';

describe('canSeedChatFromSummary', () => {
  const seed = { ...base, status: 'candidate' };
  it('allows visible radar candidates', () => expect(canSeedChatFromSummary(seed, false)).toBe(true));
  it('rejects archived, unscored, noise and unapproved deep_read for members', () => {
    expect(canSeedChatFromSummary({ ...seed, status: 'archived' }, true)).toBe(false);
    expect(canSeedChatFromSummary({ ...seed, distilledScore: null }, false)).toBe(false);
    expect(canSeedChatFromSummary({ ...seed, distilledTier: 'noise' }, false)).toBe(false);
    expect(canSeedChatFromSummary({ ...seed, contentReviewStatus: null }, false)).toBe(false);
  });
  it('allows published non-radar summaries only when published', () => {
    const plain = { ...seed, source: 'manual', syncRunId: null };
    expect(canSeedChatFromSummary({ ...plain, status: 'published' }, false)).toBe(true);
    expect(canSeedChatFromSummary(plain, false)).toBe(false);
  });
});
