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
  createMany: vi.fn(),
  findMany: vi.fn(),
  runFindMany: vi.fn(),
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

function mockRevisionRuns(runs: Array<Record<string, unknown>>) {
  mocks.runFindMany.mockImplementation(async ({ select, orderBy }: {
    select: Record<string, boolean>;
    orderBy?: unknown;
  }) => {
    const ordered = orderBy ? [...runs].sort((a, b) => (
      new Date(b.createdAt as Date).getTime() - new Date(a.createdAt as Date).getTime()
    )) : runs;
    return ordered.map(run => Object.fromEntries(Object.entries(run).filter(([key]) => select[key])));
  });
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
  mockRevisionRuns([{
    ...research.reviewRuns[0],
    decisions: [
      { id: 'd1', claimId: 'claim-1', revisionHash: research.reviewRuns[0].revisionHash, action: 'accept_uncertainty', reason: '批量接受', metadata: {}, actorId: USER_ID, createdAt: new Date() },
      { id: 'd2', claimId: 'claim-2', revisionHash: research.reviewRuns[0].revisionHash, action: 'accept_uncertainty', reason: '批量接受', metadata: {}, actorId: USER_ID, createdAt: new Date() },
    ],
  }]);
  mocks.createMany.mockResolvedValue({ count: 2 });
  mocks.transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => callback({
    $executeRaw: vi.fn(),
    research: { findUnique: mocks.txResearchFindUnique, update: mocks.txResearchUpdate },
    researchReviewRun: { findUnique: mocks.txRunFindUnique, findMany: mocks.runFindMany },
    researchReviewDecision: { createMany: mocks.createMany, findMany: mocks.findMany },
  }));
});

describe('batch review claim decisions', () => {
  it('uses the latest full inventory rather than an older conflicting review', async () => {
    const research = baseResearch(twoClaims);
    const latest = {
      ...research.reviewRuns[0], createdAt: new Date('2026-11-24T10:00:00Z'),
      summary: { coverage_status: 'complete' },
      decisions: await mocks.findMany({ where: { researchReviewRunId: RUN_ID } }),
    };
    mockRevisionRuns([
      { ...latest, id: 'old-full', createdAt: new Date('2026-11-23T10:00:00Z'), outcome: 'blocked',
        claims: [{ claim_id: 'old-conflict', claim: 'An outdated conflict', risk: 'high', verdict: 'contradicted' }], decisions: [] },
      latest,
    ]);
    const response = await batchPost(new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: RUN_ID, claimIds: ['claim-1', 'claim-2'], reason: 'Accept current uncertainties.' }),
    }) as never, params());
    expect(response.status).toBe(201);
    expect((await response.json()).publicationGate.status).toBe('publish_with_disclosure');
    expect(mocks.txResearchUpdate).toHaveBeenCalledWith({ where: { id: RESEARCH_ID }, data: { reviewStatus: 'passed' } });
    expect(mocks.runFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { researchId: RESEARCH_ID, revisionHash: research.reviewRuns[0].revisionHash },
      select: expect.objectContaining({ createdAt: true, details: true, triggeredBy: true }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }));
  });

  it.each(['details', 'triggeredBy'])('preserves unrelated conflicts when local scope comes from %s', async (scopeField) => {
    const research = baseResearch(twoClaims);
    const local = { ...research.reviewRuns[0], createdAt: new Date('2026-11-24T10:00:00Z'),
      summary: { coverage_status: 'complete' },
      ...(scopeField === 'details' ? { details: { reviewMode: 'evidence_challenge' } } : { triggeredBy: 'evidence_challenge' }),
      decisions: await mocks.findMany({ where: { researchReviewRunId: RUN_ID } }),
    };
    mockRevisionRuns([
      { ...research.reviewRuns[0], id: 'full-review', createdAt: new Date('2026-11-23T10:00:00Z'),
        outcome: 'blocked', summary: { coverage_status: 'complete' },
        claims: [{ claim_id: 'unrelated', claim: 'A remaining conflict', risk: 'high', verdict: 'contradicted' }] },
      local,
    ]);
    const response = await batchPost(new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: RUN_ID, claimIds: ['claim-1', 'claim-2'], reason: 'Accept only these uncertainties.' }),
    }) as never, params());
    expect(response.status).toBe(201);
    expect((await response.json()).publicationGate.status).toBe('blocked');
    expect(mocks.txResearchUpdate).toHaveBeenCalledWith({ where: { id: RESEARCH_ID }, data: { reviewStatus: 'blocked' } });
  });

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


  it('accepts decisions on a published report', async () => {
    const research = { ...baseResearch(twoClaims), status: 'published' };
    mocks.researchFindUnique.mockResolvedValue(research);
    mocks.txResearchFindUnique.mockResolvedValue(research);
    mocks.txRunFindUnique.mockResolvedValue(research.reviewRuns[0]);
    const response = await batchPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: RUN_ID, claimIds: ['claim-1'], reason: '发布后补充确认。' }),
      }) as never,
      params(),
    );
    expect(response.status).toBe(201);
    expect(mocks.createMany).toHaveBeenCalledTimes(1);
  });

  it('is idempotent when the same claims were already accepted', async () => {
    const research = baseResearch(twoClaims);
    const existing = [{
      id: 'd1', claimId: 'claim-1', revisionHash: research.reviewRuns[0].revisionHash,
      action: 'accept_uncertainty', reason: '批量接受', metadata: {}, actorId: USER_ID, createdAt: new Date(),
    }];
    mocks.txRunFindUnique.mockResolvedValue({ ...research.reviewRuns[0], decisions: existing });
    const response = await batchPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: RUN_ID, claimIds: ['claim-1'], reason: '重复提交。' }),
      }) as never,
      params(),
    );
    expect(response.status).toBe(201);
    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ acceptedCount: 0, alreadyAcceptedCount: 1 });
  });

  it('locks the run before reading the decisions used for deduplication', async () => {
    const lock = vi.fn().mockResolvedValue(1);
    mocks.transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => callback({
      $executeRaw: lock,
      research: { findUnique: mocks.txResearchFindUnique, update: vi.fn() },
      researchReviewRun: { findUnique: mocks.txRunFindUnique, findMany: mocks.runFindMany },
      researchReviewDecision: { createMany: mocks.createMany, findMany: mocks.findMany },
    }));
    const response = await batchPost(new Request(`http://localhost/api/researches/${RESEARCH_ID}/review/decisions/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: RUN_ID, claimIds: ['claim-1'], reason: 'Concurrent accept.' }),
    }) as never, params());
    expect(response.status).toBe(201);
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.txRunFindUnique.mock.invocationCallOrder[0]);
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
