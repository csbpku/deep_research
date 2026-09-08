import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RESEARCH_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  researchFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  transaction: vi.fn(),
  fetchAiEngine: vi.fn(),
  getWebEnv: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('../../../lib/auth/session.js', () => ({ requireUser: mocks.requireUser }));
vi.mock('../../../lib/db.js', () => ({
  prisma: {
    research: { findUnique: mocks.researchFindUnique },
    researchEvidenceTask: { findFirst: mocks.taskFindFirst },
    $transaction: mocks.transaction,
  },
}));
vi.mock('../../../lib/ai-bff/fetch-ai-engine.js', () => ({ fetchAiEngine: mocks.fetchAiEngine }));
vi.mock('../../../lib/env.js', () => ({ getWebEnv: mocks.getWebEnv }));

import { POST as evidenceTaskPost } from '../researches/[id]/evidence-tasks/route';
import { hashResearchRevision } from '../../../lib/research-revision';

function baseResearch() {
  const fields = {
    id: RESEARCH_ID,
    authorId: USER_ID,
    status: 'draft',
    creationMethod: 'ai_research',
    title: '审核测试',
    body: '报告正文',
    background: null,
    conclusion: null,
    risks: null,
    tags: [],
  };
  const revisionHash = hashResearchRevision(fields);
  return {
    ...fields,
    sourceAiJob: { id: '44444444-4444-4444-8444-444444444444' },
    reviewRuns: [{
      id: RUN_ID,
      revisionHash,
      executionStatus: 'completed',
      outcome: 'attention',
      attempt: 1,
      summary: { coverage_status: 'complete' },
      claims: [{
        claim_id: 'claim-1',
        claim: '声明缺少直接证据',
        risk: 'medium',
        verdict: 'unsupported',
        evidence: null,
      }],
      decisions: [],
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'admin' });
  mocks.researchFindUnique.mockResolvedValue(baseResearch());
  mocks.taskFindFirst.mockResolvedValue(null);
  mocks.getWebEnv.mockReturnValue({ AI_ENGINE_URL: 'http://ai-engine.test' });
  mocks.fetchAiEngine.mockResolvedValue({ ok: true, status: 202, body: { job_id: 'job-1', status: 'queued' } });
  mocks.transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => callback({
    aiResearchJob: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
    researchEvidenceTask: {
      create: vi.fn().mockResolvedValue({
        id: 'task-1',
        status: 'queued',
        sourceCount: 0,
        reviewRunId: null,
        claimId: 'claim-1',
        revisionHash: hashResearchRevision(baseResearch()),
        createdAt: new Date('2026-09-07T10:00:00.000Z'),
      }),
    },
  }));
});

describe('claim-scoped evidence tasks', () => {
  it('creates a durable retrieval job instead of reusing the review rerun action', async () => {
    const response = await evidenceTaskPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/evidence-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: RUN_ID, claimId: 'claim-1' }),
      }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );

    expect(response.status).toBe(202);
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://ai-engine.test/api/ai/jobs',
      body: expect.objectContaining({ report_type: 'evidence_search', source_refs: [] }),
    }));
    expect(await response.json()).toMatchObject({
      ok: true,
      task: { id: 'task-1', status: 'queued', claimId: 'claim-1' },
    });
  });
});
