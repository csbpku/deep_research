import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RESEARCH_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  researchFindUnique: vi.fn(),
  txResearchFindUnique: vi.fn(),
  txRunFindUnique: vi.fn(),
  createMany: vi.fn(),
  findMany: vi.fn(),
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

import { POST as batchPost } from '../researches/[id]/review/decisions/batch/route';
import { hashResearchRevision } from '../../../lib/research-revision';

function params(id = RESEARCH_ID) {
  return { params: Promise.resolve({ id }) };
}

function baseResearch(claims: Array<Record<string, unknown>>) {
  const body = '报告正文';
  const fields = {
    id: RESEARCH_ID,
    authorId: USER_ID,
    status: 'draft',
    creationMethod: 'ai_research',
    title: '批量审核测试',
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
    sourceAiJob: null,
    researchSources: [],
    reviewRuns: [{
      id: RUN_ID,
      revisionHash,
      executionStatus: 'completed',
      outcome: 'attention',
      attempt: 1,
      summary: null,
      claims,
      decisions: [],
    }],
  };
}

const twoClaims = [
  { claim_id: 'claim-1', claim: '一条证据不足的中风险声明', risk: 'medium', verdict: 'unsupported', evidence: null },
  { claim_id: 'claim-2', claim: '另一条证据不足的低风险声明', risk: 'low', verdict: 'unsupported', evidence: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'admin' });
  const research = baseResearch(twoClaims);
  mocks.researchFindUnique.mockResolvedValue(research);
  mocks.txResearchFindUnique.mockResolvedValue(research);
  mocks.txRunFindUnique.mockResolvedValue(research.reviewRuns[0]);
  mocks.findMany.mockImplementation(async ({ where }: { where: { researchReviewRunId: string } }) => {
    // The route re-reads the ledger after createMany; mirror the two rows it
    // just wrote so the gate can resolve both claims.
    return [
      { id: 'd1', claimId: 'claim-1', revisionHash: research.reviewRuns[0].revisionHash, action: 'accept_uncertainty', reason: '批量接受', metadata: {}, actorId: USER_ID, createdAt: new Date() },
      { id: 'd2', claimId: 'claim-2', revisionHash: research.reviewRuns[0].revisionHash, action: 'accept_uncertainty', reason: '批量接受', metadata: {}, actorId: USER_ID, createdAt: new Date() },
    ].filter((row) => row.revisionHash === research.reviewRuns[0].revisionHash && where.researchReviewRunId === RUN_ID);
  });
  mocks.createMany.mockResolvedValue({ count: 2 });
  mocks.transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => callback({
    research: { findUnique: mocks.txResearchFindUnique },
    researchReviewRun: { findUnique: mocks.txRunFindUnique },
    researchReviewDecision: { createMany: mocks.createMany, findMany: mocks.findMany },
  }));
});

describe('batch review claim decisions', () => {
  it('accepts several low/medium-risk unverified claims with one reason', async () => {
    const response = await batchPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: RUN_ID,
          claimIds: ['claim-1', 'claim-2'],
          reason: '内部讨论用，方向已人工确认。',
        }),
      }) as never,
      params(),
    );

    expect(response.status).toBe(201);
    expect(mocks.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.createMany.mock.calls[0][0].data).toHaveLength(2);
    expect(mocks.createMany.mock.calls[0][0].data[0]).toMatchObject({
      claimId: 'claim-1',
      action: 'accept_uncertainty',
      actorId: USER_ID,
    });
    expect(await response.json()).toMatchObject({ acceptedCount: 2 });
  });

  it('rejects a high-risk claim instead of silently skipping it', async () => {
    const research = baseResearch([
      twoClaims[0],
      { claim_id: 'claim-high', claim: '一条高风险声明', risk: 'high', verdict: 'unsupported', evidence: null },
    ]);
    mocks.researchFindUnique.mockResolvedValue(research);
    const response = await batchPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: RUN_ID,
          claimIds: ['claim-1', 'claim-high'],
          reason: '尝试批量接受。',
        }),
      }) as never,
      params(),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      message: '这些声明不能批量接受为待验证项。',
      details: {
        ineligible: expect.arrayContaining([{ claimId: 'claim-high', reason: 'high_risk' }]),
      },
    });
    expect(mocks.createMany).not.toHaveBeenCalled();
  });
});
