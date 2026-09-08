import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RESEARCH_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  researchFindUnique: vi.fn(),
  txResearchFindUnique: vi.fn(),
  txResearchUpdate: vi.fn(),
  txRunFindUnique: vi.fn(),
  txRunCreate: vi.fn(),
  inheritedDecisionCreateMany: vi.fn(),
  txJobUpdate: vi.fn(),
  decisionCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('../../../lib/auth/session.js', () => ({ requireUser: mocks.requireUser }));
vi.mock('../../../lib/db.js', () => ({
  prisma: {
    research: { findUnique: mocks.researchFindUnique },
    $transaction: mocks.transaction,
  },
}));

import { POST as decisionPost } from '../researches/[id]/review/decisions/route';
import { hashResearchRevision } from '../../../lib/research-revision';

function params(id = RESEARCH_ID) {
  return { params: Promise.resolve({ id }) };
}

function baseResearch() {
  const body = '报告正文';
  const fields = {
    id: RESEARCH_ID,
    authorId: USER_ID,
    status: 'draft',
    creationMethod: 'ai_research',
    title: '审核测试',
    body,
    background: '背景',
    conclusion: '结论',
    risks: '风险',
    tags: [],
    reviewStatus: 'needs_revision',
  };
  const revisionHash = hashResearchRevision(fields);
  return {
    ...fields,
    reviewRuns: [{
      id: RUN_ID,
      revisionHash,
      sourceSnapshotHash: 's'.repeat(64),
      policyVersion: 'fact-review-v1',
      executionStatus: 'completed',
      outcome: 'attention',
      attempt: 1,
      startedAt: new Date(),
      leaseExpiresAt: null,
      heartbeatAt: null,
      completedAt: new Date(),
      summary: null,
      claims: [{
        claim_id: 'claim-1',
        claim: '一条证据不足的中风险声明',
        risk: 'medium',
        verdict: 'unsupported',
        evidence: null,
      }],
      details: null,
      triggeredBy: 'system',
      createdAt: new Date(),
      decisions: [],
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'admin' });
  const research = baseResearch();
  mocks.researchFindUnique.mockResolvedValue(research);
  mocks.txResearchFindUnique.mockResolvedValue(research);
  mocks.txRunFindUnique.mockResolvedValue(research.reviewRuns[0]);
  mocks.decisionCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
    id: 'decision-1',
    ...data,
    createdAt: new Date('2026-09-07T10:00:00.000Z'),
  }));
  mocks.transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => callback({
    research: { findUnique: mocks.txResearchFindUnique, update: mocks.txResearchUpdate },
    researchReviewRun: { findUnique: mocks.txRunFindUnique, create: mocks.txRunCreate },
    aiResearchJob: { update: mocks.txJobUpdate },
    researchReviewDecision: { create: mocks.decisionCreate, createMany: mocks.inheritedDecisionCreateMany },
  }));
});

describe('human review claim decisions', () => {
  it('records an accepted low/medium-risk uncertainty and makes the gate publishable with disclosure', async () => {
    const response = await decisionPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: RUN_ID,
          claimId: 'claim-1',
          action: 'accept_uncertainty',
          reason: '这是低风险开放问题，报告会保留风险说明。',
        }),
      }) as never,
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.decisionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        researchReviewRunId: RUN_ID,
        claimId: 'claim-1',
        action: 'accept_uncertainty',
        actorId: USER_ID,
      }),
    }));
    expect(await response.json()).toMatchObject({
      publicationGate: { status: 'publish_with_disclosure', openCount: 0, disclosedCount: 1 },
    });
  });

  it('requires a reason for accepting uncertainty', async () => {
    const response = await decisionPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claimId: 'claim-1', action: 'accept_uncertainty' }),
      }) as never,
      params(),
    );
    expect(response.status).toBe(400);
    expect(mocks.decisionCreate).not.toHaveBeenCalled();
  });

  it('does not allow a high-risk conflict to be dismissed as an accepted risk', async () => {
    const research = baseResearch() as any;
    research.reviewRuns[0].claims = [{
      claim_id: 'claim-1',
      claim: '高风险冲突',
      risk: 'high',
      verdict: 'contradicted',
      evidence: { excerpt: '相反证据' },
    }];
    research.reviewRuns[0].outcome = 'blocked';
    mocks.researchFindUnique.mockResolvedValue(research);
    mocks.txResearchFindUnique.mockResolvedValue(research);
    mocks.txRunFindUnique.mockResolvedValue(research.reviewRuns[0]);

    const response = await decisionPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: RUN_ID,
          claimId: 'claim-1',
          action: 'accept_conflict_risk',
          reason: '暂时接受',
        }),
      }) as never,
      params(),
    );
    expect(response.status).toBe(400);
    expect(mocks.decisionCreate).not.toHaveBeenCalled();
  });

  it('records a verification workflow event and queues the replacement run atomically', async () => {
    const research = baseResearch() as any;
    research.sourceAiJob = { id: '44444444-4444-4444-8444-444444444444' };
    research.researchSources = [{
      sourceRef: { type: 'url', value: 'https://example.com/source' },
      canonicalKey: 'https://example.com/source',
      title: 'Example source',
      description: 'Direct excerpt',
    }];
    mocks.researchFindUnique.mockResolvedValue(research);
    mocks.txResearchFindUnique.mockResolvedValue(research);
    mocks.txRunFindUnique.mockResolvedValue(research.reviewRuns[0]);
    mocks.txRunCreate.mockResolvedValue({});
    mocks.txJobUpdate.mockResolvedValue({});

    const response = await decisionPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: RUN_ID,
          claimId: 'claim-1',
          action: 'request_verification',
        }),
      }) as never,
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.decisionCreate).not.toHaveBeenCalled();
    expect(mocks.txRunCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        researchId: RESEARCH_ID,
        executionStatus: 'queued',
        triggeredBy: 'claim_verification',
        details: expect.objectContaining({
          workflowEvent: expect.objectContaining({
            type: 'reverify_current_evidence',
            claimId: 'claim-1',
          }),
        }),
      }),
    }));
    expect(await response.json()).toMatchObject({
      decision: null,
      queuedReview: { executionStatus: 'queued', triggeredBy: 'claim_verification' },
      publicationGate: { status: 'needs_action' },
    });
  });

  it('carries accepted uncertainty into a claim re-check without reopening unrelated items', async () => {
    const research = baseResearch() as any;
    research.sourceAiJob = { id: '44444444-4444-4444-8444-444444444444' };
    research.researchSources = [{
      sourceRef: { type: 'url', value: 'https://example.com/source' },
      canonicalKey: 'https://example.com/source',
      title: 'Example source',
      description: 'Direct excerpt',
    }];
    research.reviewRuns[0].decisions = [{
      id: 'decision-existing',
      claimId: 'claim-2',
      revisionHash: research.reviewRuns[0].revisionHash,
      action: 'accept_uncertainty',
      reason: '保留为待验证项',
      metadata: { source: 'author' },
      actorId: USER_ID,
      createdAt: new Date('2026-09-07T10:00:00.000Z'),
    }];
    mocks.researchFindUnique.mockResolvedValue(research);
    mocks.txResearchFindUnique.mockResolvedValue(research);
    mocks.txRunFindUnique.mockResolvedValue(research.reviewRuns[0]);
    mocks.txRunCreate.mockResolvedValue({});

    const response = await decisionPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: RUN_ID,
          claimId: 'claim-1',
          action: 'request_verification',
        }),
      }) as never,
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.inheritedDecisionCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        claimId: 'claim-2',
        action: 'accept_uncertainty',
      })],
    });
    const inherited = mocks.inheritedDecisionCreateMany.mock.calls[0][0].data[0] as Record<string, unknown>;
    expect(inherited.metadata).toMatchObject({
      source: 'author',
      inheritedFromRunId: RUN_ID,
    });
  });

  it('lets the author challenge a machine-supported evidence link without resolving the claim', async () => {
    const research = baseResearch() as any;
    research.reviewRuns[0].claims = [{
      claim_id: 'claim-1',
      claim: '一条已有直接摘录支持的声明',
      risk: 'medium',
      verdict: 'verified',
      evidence: {
        source_url: 'https://example.com/source',
        excerpt: '直接摘录支持这条声明。',
      },
    }];
    research.researchSources = [{
      sourceRef: { type: 'url', value: 'https://example.com/source' },
      canonicalKey: 'https://example.com/source',
      title: 'Example source',
      description: 'Direct excerpt',
    }];
    mocks.researchFindUnique.mockResolvedValue(research);
    mocks.txResearchFindUnique.mockResolvedValue(research);
    mocks.txRunFindUnique.mockResolvedValue(research.reviewRuns[0]);
    mocks.txRunCreate.mockResolvedValue({});

    const response = await decisionPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: RUN_ID,
          claimId: 'claim-1',
          action: 'challenge_support',
          reason: '摘录只描述背景，不能推出这条结论。',
        }),
      }) as never,
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.decisionCreate).not.toHaveBeenCalled();
    expect(mocks.txRunCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        triggeredBy: 'evidence_challenge',
        details: expect.objectContaining({
          workflowEvent: expect.objectContaining({
            type: 'challenge_machine_support',
            claimId: 'claim-1',
          }),
        }),
      }),
    }));
    expect(await response.json()).toMatchObject({
      decision: null,
      queuedReview: { executionStatus: 'queued', triggeredBy: 'evidence_challenge' },
    });
  });

  it('rejects a decision when the document changed after the ledger was loaded', async () => {
    mocks.txResearchFindUnique.mockResolvedValue({ ...baseResearch(), body: '新的正文' });
    const response = await decisionPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: RUN_ID,
          claimId: 'claim-1',
          action: 'accept_uncertainty',
          reason: '保留为待验证项',
        }),
      }) as never,
      params(),
    );
    expect(response.status).toBe(409);
    expect(mocks.decisionCreate).not.toHaveBeenCalled();
  });
});
