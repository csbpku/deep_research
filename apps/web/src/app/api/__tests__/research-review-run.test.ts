import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RESEARCH_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  researchFindUnique: vi.fn(),
  researchReviewRunFindFirst: vi.fn(),
  researchReviewRunCreate: vi.fn(),
  researchReviewRunUpdate: vi.fn(),
  researchUpdate: vi.fn(),
  researchUpdateMany: vi.fn(),
  aiResearchJobUpdate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('../../../lib/auth/session.js', () => ({
  requireUser: mocks.requireUser,
}));
vi.mock('../../../lib/db.js', () => ({
  prisma: {
    research: { findUnique: mocks.researchFindUnique },
    $transaction: mocks.transaction,
  },
}));

import { POST as reviewPost } from '../researches/[id]/review/route';

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function draft() {
  return {
    id: RESEARCH_ID,
    authorId: USER_ID,
    status: 'draft',
    creationMethod: 'ai_research',
    title: '审核流程',
    body: '# 结论\n\n一条需要核对的声明。',
    reviewStatus: 'review_unavailable',
    reviewAttempts: 1,
    sourceAiJob: { id: JOB_ID },
    researchSources: [{
      sourceRef: { type: 'url', value: 'https://example.com/docs' },
      canonicalKey: 'https://example.com/docs',
      title: '官方文档',
      description: '原文摘录',
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'admin' });
  mocks.researchFindUnique.mockResolvedValue(draft());
  mocks.researchReviewRunFindFirst.mockResolvedValue(null);
  mocks.researchUpdateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => callback({
    researchReviewRun: {
      findFirst: mocks.researchReviewRunFindFirst,
      create: mocks.researchReviewRunCreate,
      update: mocks.researchReviewRunUpdate,
    },
    aiResearchJob: { update: mocks.aiResearchJobUpdate },
    research: { update: mocks.researchUpdate, updateMany: mocks.researchUpdateMany },
  }));
});

describe('version-scoped fact review runs', () => {
  it('queues a new run and returns 202 without waiting for the reviewer', async () => {
    const response = await reviewPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review`, { method: 'POST' }) as never,
      params(RESEARCH_ID),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: 'queued',
      run: { executionStatus: 'queued', attempt: 0, policyVersion: 'fact-review-v1' },
    });
    expect(mocks.researchReviewRunCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        researchId: RESEARCH_ID,
        aiResearchJobId: JOB_ID,
        executionStatus: 'queued',
        triggeredBy: 'manual',
      }),
    }));
    expect(mocks.aiResearchJobUpdate).toHaveBeenCalled();
    expect(mocks.researchUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: RESEARCH_ID, status: 'draft' },
    }));
  });

  it('allows an admin to review another member\'s draft', async () => {
    mocks.researchFindUnique.mockResolvedValue({ ...draft(), authorId: 'another-user' });

    const response = await reviewPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review`, { method: 'POST' }) as never,
      params(RESEARCH_ID),
    );

    expect(response.status).toBe(202);
    expect(mocks.researchReviewRunCreate).toHaveBeenCalled();
  });

  it('does not create a second run while one is queued or reviewing', async () => {
    mocks.researchReviewRunFindFirst.mockResolvedValue({ id: 'active-run' });

    const response = await reviewPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review`, { method: 'POST' }) as never,
      params(RESEARCH_ID),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'AI_REVIEW_CONFLICT' });
    expect(mocks.researchReviewRunCreate).not.toHaveBeenCalled();
  });

  it('closes an expired reviewer lease and queues a recoverable replacement', async () => {
    mocks.researchReviewRunFindFirst.mockResolvedValue({
      id: 'expired-run',
      executionStatus: 'reviewing',
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
      leaseExpiresAt: new Date(Date.now() - 60 * 1000),
      details: { workerId: 'dead-worker', claimToken: 'old-token' },
    });

    const response = await reviewPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review`, { method: 'POST' }) as never,
      params(RESEARCH_ID),
    );

    expect(response.status).toBe(202);
    expect(mocks.researchReviewRunUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'expired-run' },
      data: expect.objectContaining({
        executionStatus: 'unavailable',
        outcome: 'unavailable',
        leaseExpiresAt: null,
      }),
    }));
    expect(mocks.researchReviewRunCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ executionStatus: 'queued' }),
    }));
  });

  it('rolls back queueing when the draft is no longer publishable', async () => {
    mocks.researchUpdateMany.mockResolvedValue({ count: 0 });

    const response = await reviewPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/review`, { method: 'POST' }) as never,
      params(RESEARCH_ID),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'AI_REVIEW_CONFLICT' });
  });
});
