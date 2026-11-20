import { describe, expect, it } from 'vitest';
import { projectResearchReviewForReader } from './research-review-reader';
import type { CurrentReviewState, ReviewRunState } from './research-review-state';

const revisionHash = 'a'.repeat(64);

function run(overrides: Partial<ReviewRunState>): ReviewRunState {
  return {
    id: 'run',
    revisionHash,
    executionStatus: 'completed',
    outcome: 'clear',
    attempt: 1,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    summary: { coverage_status: 'complete' },
    claims: [],
    decisions: [],
    ...overrides,
  };
}

describe('research review inventory', () => {
  it('does not let a zero-claim clear run truncate an older conflict', () => {
    const older = run({
      id: 'older',
      createdAt: new Date('2026-11-01T00:00:00Z'),
      claims: [{
        claim_id: 'C1',
        claim: 'The API defaults to 10 retries.',
        claim_type: 'external_fact',
        risk: 'high',
        verdict: 'contradicted',
        judgment_status: 'settled',
      }],
    });
    const degraded = run({
      id: 'degraded',
      createdAt: new Date('2026-11-02T00:00:00Z'),
      claims: [],
    });
    const currentReview = {
      revisionHash, status: 'clear', outcome: 'clear', run: degraded,
      attempt: 1, isCurrentRevision: true, isLegacyFallback: false,
    } as unknown as CurrentReviewState;

    const reader = projectResearchReviewForReader({
      status: 'published',
      creationMethod: 'ai_research',
      currentReview,
      reviewRuns: [degraded, older],
      researchSufficiencyStatus: 'sufficient',
    });

    expect(reader.reviewVerification).toBe('conflicted');
    expect(reader.reviewDisclosure).toHaveLength(1);
    expect(reader.reviewDisclosure[0]).toMatchObject({ claim: 'The API defaults to 10 retries.', evidenceStatus: 'contradicted' });
    expect(reader.reviewDisclosureSummary).toMatchObject({ conflictCount: 1, machineIncomplete: true, retainedPreviousRisks: true });
  });
});
