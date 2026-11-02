import { describe, expect, it } from 'vitest';

import { getReviewPublicationGate } from '@/lib/research-review-decisions';

/**
 * The in-chat review panel relies on the shared gate helper. Pin the one
 * behaviour that makes the panel necessary: an unverified claim keeps the
 * report out of the publishable state until someone disposes of it.
 */
describe('in-chat review gate', () => {
  const unverifiedClaim = {
    claim_id: 'c1',
    claim: 'Grok Bot 在 2026 年仍然可用。',
    claim_type: 'external_fact',
    risk: 'medium',
    verdict: 'unverified',
  };

  it('blocks publication while a factual claim has no evidence', () => {
    const gate = getReviewPublicationGate({
      executionStatus: 'completed',
      outcome: 'needs_action',
      claims: [unverifiedClaim],
      decisions: [],
    });
    expect(gate.status).toBe('needs_action');
    expect(gate.openCount).toBeGreaterThan(0);
  });

  it('clears the gate once the author accepts a low-risk uncertainty', () => {
    const gate = getReviewPublicationGate({
      executionStatus: 'completed',
      outcome: 'needs_action',
      claims: [unverifiedClaim],
      decisions: [{ claimId: 'c1', action: 'accept_uncertainty', reason: '低风险待验证项' }],
    });
    expect(gate.status).not.toBe('needs_action');
  });
});
