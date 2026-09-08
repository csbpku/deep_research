import { describe, expect, it } from 'vitest';
import { hashResearchRevision } from './research-revision';
import { resolveCurrentReviewState } from './research-review-state';

const revision = {
  title: '研究标题',
  body: '# 正文\n\n当前内容',
  background: '背景',
  conclusion: '结论',
  risks: '风险',
  tags: ['研究'],
};

describe('resolveCurrentReviewState', () => {
  it('uses the exact current revision run', () => {
    const revisionHash = hashResearchRevision(revision);
    const state = resolveCurrentReviewState(revision, [
      { id: 'current', revisionHash, executionStatus: 'completed', outcome: 'clear', attempt: 2 },
      { id: 'old', revisionHash: 'a'.repeat(64), executionStatus: 'completed', outcome: 'blocked', attempt: 1 },
    ]);

    expect(state).toMatchObject({ status: 'passed', outcome: 'clear', isCurrentRevision: true, attempt: 2 });
    expect(state.run?.id).toBe('current');
  });

  it('makes an old passed mirror stale once the relation is loaded', () => {
    const state = resolveCurrentReviewState(revision, [
      { id: 'old', revisionHash: 'a'.repeat(64), executionStatus: 'completed', outcome: 'clear', attempt: 1 },
    ], 'passed');

    expect(state).toMatchObject({ status: 'stale', outcome: 'stale', isCurrentRevision: false, isLegacyFallback: false });
  });

  it('only allows the compatibility fallback when runs were not loaded', () => {
    const state = resolveCurrentReviewState(revision, undefined, 'passed');
    expect(state).toMatchObject({ status: 'passed', outcome: 'clear', isCurrentRevision: true, isLegacyFallback: true });
  });

  it('does not treat a stale run for the same hash as a valid verdict', () => {
    const revisionHash = hashResearchRevision(revision);
    const state = resolveCurrentReviewState(revision, [
      { id: 'stale', revisionHash, executionStatus: 'stale', outcome: 'stale', attempt: 1 },
    ]);
    expect(state.status).toBe('stale');
    expect(state.isCurrentRevision).toBe(false);
  });
});
