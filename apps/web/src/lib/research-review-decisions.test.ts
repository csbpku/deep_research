import { describe, expect, it } from 'vitest';

import {
  decisionResolvesClaim,
  getReviewDisclosureItems,
  getReviewPublicationGate,
  claimIsFactual,
  claimHasCapturedSourceMatch,
  reviewClaimNextAction,
  reviewClaimLocation,
  type ReviewClaimForDecision,
} from './research-review-decisions';

const unsupported: ReviewClaimForDecision = {
  claim_id: 'claim-1',
  claim: '这是一条缺少足够证据的声明',
  risk: 'medium',
  verdict: 'unsupported',
  evidence: null,
};

const highConflict: ReviewClaimForDecision = {
  claim_id: 'claim-2',
  claim: '这是一条被来源明确反驳的关键事实',
  risk: 'high',
  verdict: 'contradicted',
  evidence: { excerpt: '来源明确写出相反结论。' },
};

const lowConflict: ReviewClaimForDecision = {
  claim_id: 'claim-3',
  claim: '一条被来源相反描述的普通事实',
  risk: 'low',
  verdict: 'contradicted',
  evidence: { excerpt: '来源给出了相反描述。' },
};

describe('research review publication decisions', () => {
  it('keeps research-process observations out of the fact-review gate', () => {
    const processObservation: ReviewClaimForDecision = {
      claim_id: 'process-1',
      claim: '本轮仅抓取到官方文档的目录页，未抓取到安装正文',
      risk: 'medium',
      verdict: 'unverified',
      claim_type: 'research_process',
      evidence: null,
    };
    expect(claimIsFactual(processObservation)).toBe(false);
    expect(getReviewPublicationGate({
      executionStatus: 'completed',
      outcome: 'attention',
      claims: [processObservation],
      decisions: [],
    })).toMatchObject({ status: 'clear', openCount: 0, unsupportedCount: 0 });
  });

  it('keeps legacy process wording out of the queue before a re-review', () => {
    expect(claimIsFactual({
      claim_id: 'legacy-process',
      claim: '本轮没有保存可核对正文',
      risk: 'medium',
      verdict: 'unverified',
    })).toBe(false);
  });

  it('routes each evidence state to one primary next action', () => {
    expect(reviewClaimNextAction({
      ...unsupported,
      evidence: null,
    })).toBe('find_more_evidence');
    expect(reviewClaimNextAction({
      ...unsupported,
      evidence: { source_url: 'https://example.com/source', excerpt: null },
    })).toBe('reverify_current_sources');
    expect(reviewClaimNextAction(highConflict)).toBe('edit_claim');
    expect(reviewClaimNextAction({
      claim_id: 'supported',
      claim: '已被直接摘录支持的声明',
      risk: 'medium',
      verdict: 'verified',
      evidence: { excerpt: '直接摘录' },
    })).toBe('challenge_support');
  });

  it('routes a legacy unbound claim back to current-source verification when the ledger has a strong match', () => {
    expect(claimHasCapturedSourceMatch(
      {
        claim_id: 'legacy-unbound',
        claim: '目录中提及 Playwright MCP、CLI、API、Test、Agents、Annotations 等条目',
        risk: 'medium',
        verdict: 'unverified',
        evidence: null,
      },
      [{
        title: 'Installation | Playwright',
        snippet: '目录中提及 Playwright MCP、CLI、API、Test、Agents、Annotations 等条目。',
      }],
    )).toBe(true);
    expect(claimHasCapturedSourceMatch(unsupported, [{
      title: 'Unrelated source',
      snippet: '这里只介绍完全不同的内容。',
    }])).toBe(false);
  });

  it('normalizes worker offsets without trusting malformed locations', () => {
    const located = {
      ...unsupported,
      location: [10, 22] as [number, number],
    };
    expect(reviewClaimLocation(located)).toEqual([10, 22]);
    expect(reviewClaimLocation({ ...unsupported, location: [-1, 4] })).toBeNull();
  });

  it('does not treat evidence insufficiency as a false fact', () => {
    const gate = getReviewPublicationGate({
      executionStatus: 'completed',
      outcome: 'attention',
      claims: [unsupported],
      decisions: [],
    });
    expect(gate.status).toBe('needs_action');
    expect(gate.hardBlockCount).toBe(0);
    expect(gate.unsupportedCount).toBe(1);
  });

  it('allows an explicit low/medium-risk uncertainty decision with disclosure', () => {
    const decision = {
      claimId: 'claim-1',
      action: 'accept_uncertainty',
      reason: '这是低风险开放问题，报告会保留风险说明。',
      createdAt: '2026-09-07T10:00:00.000Z',
    };
    expect(decisionResolvesClaim(unsupported, decision)).toBe(true);
    const gate = getReviewPublicationGate({
      executionStatus: 'completed',
      outcome: 'attention',
      claims: [unsupported],
      decisions: [decision],
    });
    expect(gate.status).toBe('publish_with_disclosure');
    expect(gate.disclosedCount).toBe(1);
    expect(gate.openCount).toBe(0);
    expect(getReviewDisclosureItems({ claims: [unsupported], decisions: [decision] })).toEqual([
      expect.objectContaining({
        claimId: 'claim-1',
        action: 'accept_uncertainty',
        label: '已接受待验证项',
        evidenceStatus: 'unverified',
      }),
    ]);
  });

  it('hard-blocks high-risk contradictions even if a malformed override exists', () => {
    const gate = getReviewPublicationGate({
      executionStatus: 'completed',
      outcome: 'blocked',
      claims: [highConflict],
      decisions: [{
        claimId: 'claim-2',
        action: 'accept_conflict_risk',
        reason: '暂时接受',
        createdAt: '2026-09-07T10:00:00.000Z',
      }],
    });
    expect(gate.status).toBe('blocked');
    expect(gate.hardBlockCount).toBe(1);
    expect(gate.openCount).toBe(1);
  });

  it('does not let a low-risk contradiction publish unchanged', () => {
    const decision = {
      claimId: 'claim-3',
      action: 'accept_conflict_risk',
      reason: '暂时接受',
      createdAt: '2026-09-07T10:00:00.000Z',
    };
    expect(decisionResolvesClaim(lowConflict, decision)).toBe(false);
    const gate = getReviewPublicationGate({
      executionStatus: 'completed',
      outcome: 'attention',
      claims: [lowConflict],
      decisions: [decision],
    });
    expect(gate.status).toBe('needs_action');
    expect(gate.openCount).toBe(1);
    expect(gate.disclosedCount).toBe(0);
  });

  it('does not reclassify a factual-looking sentence without editing it', () => {
    expect(decisionResolvesClaim({ ...unsupported, risk: 'high' }, {
      claimId: 'claim-1',
      action: 'mark_not_fact',
      reason: '我认为这是观点',
    })).toBe(false);
  });

  it('treats an authoritative correction as a conflict, not an uncertainty exception', () => {
    const correctable: ReviewClaimForDecision = {
      claim_id: 'claim-correctable',
      claim: '项目有 10,000 个 stars',
      risk: 'low',
      verdict: 'correctable',
      evidence: {
        source_url: 'https://api.github.com/repos/example/project',
        excerpt: '{"stargazers_count":12000}',
      },
    };
    expect(getReviewPublicationGate({
      executionStatus: 'completed',
      outcome: 'attention',
      coverageStatus: 'complete',
      claims: [correctable],
      decisions: [],
    })).toMatchObject({
      status: 'needs_action',
      conflictCount: 1,
      unsupportedCount: 0,
    });
    expect(decisionResolvesClaim(correctable, {
      claimId: 'claim-correctable',
      action: 'accept_uncertainty',
      reason: '先发布',
    })).toBe(false);
  });

  it('keeps reviewer outage separate from a content decision', () => {
    const gate = getReviewPublicationGate({
      executionStatus: 'unavailable',
      outcome: 'unavailable',
      claims: [],
      decisions: [],
    });
    expect(gate.status).toBe('unavailable');
    expect(gate.hardBlockCount).toBe(0);
  });

  it('keeps a completed but incomplete claim inventory behind a separate coverage gate', () => {
    const gate = getReviewPublicationGate({
      executionStatus: 'completed',
      outcome: 'attention',
      coverageStatus: 'insufficient',
      claims: [{
        claim_id: 'claim-1',
        claim: '审核器实际返回的一条声明',
        risk: 'medium',
        verdict: 'verified',
        evidence: { excerpt: '可检查的原文摘录' },
      }],
      decisions: [],
    });
    expect(gate.status).toBe('coverage_insufficient');
    expect(gate.coverageIncomplete).toBe(true);
    expect(gate.openCount).toBe(0);
  });

  it('lets a complete inventory reach the normal claim-level gate', () => {
    const gate = getReviewPublicationGate({
      executionStatus: 'completed',
      outcome: 'attention',
      coverageStatus: 'complete',
      claims: [unsupported],
      decisions: [{
        claimId: 'claim-1',
        action: 'accept_uncertainty',
        reason: '保留为待验证项',
        createdAt: '2026-09-07T10:00:00.000Z',
      }],
    });
    expect(gate.status).toBe('publish_with_disclosure');
    expect(gate.coverageIncomplete).toBe(false);
  });

  it('keeps a factually reviewable report blocked when the confirmed research contract is incomplete', () => {
    const gate = getReviewPublicationGate({
      executionStatus: 'completed',
      outcome: 'clear',
      coverageStatus: 'complete',
      researchSufficiencyStatus: 'insufficient',
      claims: [],
      decisions: [],
    });
    expect(gate.status).toBe('research_insufficient');
    expect(gate.researchSufficiencyStatus).toBe('insufficient');
  });
});
