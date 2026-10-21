import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RESEARCH_ID = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  researchFindUnique: vi.fn(),
  researchUpdate: vi.fn(),
  reviewRunUpdateMany: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  indexUpsert: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/db', () => ({
  prisma: {
    research: { findUnique: mocks.researchFindUnique, update: mocks.researchUpdate },
    researchAudit: { findMany: vi.fn(), create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));

import { PUT } from '../researches/[id]/route';

function existing(creationMethod: string, status = 'archived') {
  return {
    id: RESEARCH_ID, type: 'research', title: 't', body: 'old', background: null, conclusion: null, risks: null,
    tags: [], authorId: USER_ID, status, creationMethod, aiAssisted: false, readingSaveKey: null,
    knowledgeIndexText: null, sourceAiJob: null,
  };
}
const put = () => PUT(new Request(`http://localhost/api/researches/${RESEARCH_ID}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'new body' }),
}) as never, { params: Promise.resolve({ id: RESEARCH_ID }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'member' });
  mocks.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
    research: { update: mocks.researchUpdate }, researchReviewRun: { updateMany: mocks.reviewRunUpdateMany }, researchAudit: { create: mocks.auditCreate },
    personalKnowledgeIndexTask: { upsert: mocks.indexUpsert },
  }));
  mocks.researchUpdate.mockResolvedValue({
    id: RESEARCH_ID, type: 'research', status: 'archived', title: 't', body: 'new body', tags: [],
    authorId: USER_ID, creationMethod: 'manual', createdAt: new Date(), updatedAt: new Date(),
    author: { id: USER_ID, name: 'a', email: 'a@x.test' }, _count: { comments: 0 },
  });
});

describe('PUT /api/researches/[id] on archived research', () => {
  it('keeps confirmed card text indexed when its idempotency key is not a Reader origin', async () => {
    mocks.researchFindUnique.mockResolvedValue({
      ...existing('ai_research', 'draft'), type: 'knowledge',
      readingSaveKey: '55555555-5555-4555-8555-555555555555',
    });
    expect((await put()).status).toBe(200);
    expect(mocks.researchUpdate.mock.calls[0][0].data.knowledgeIndexText).toContain('new body');
    expect(mocks.indexUpsert.mock.calls[0][0].create.operation).toBe('upsert');
  });
  it('lets the owner edit an archived manual research (contract: owner may edit archived)', async () => {
    mocks.researchFindUnique.mockResolvedValue(existing('manual'));
    const res = await put();
    expect(res.status).toBe(200);
    expect(mocks.researchUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    // status is never changed by an edit
    expect(mocks.researchUpdate.mock.calls[0]![0].data).not.toHaveProperty('status');
  });

  it('lets the owner edit an archived AI research and stales in-flight reviews', async () => {
    mocks.researchFindUnique.mockResolvedValue(existing('ai_research'));
    const res = await put();
    expect(res.status).toBe(200);
    expect(mocks.researchUpdate.mock.calls[0]![0].data).not.toHaveProperty('status');
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.reviewRunUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { researchId: RESEARCH_ID, executionStatus: { in: ['queued', 'reviewing'] } },
      data: expect.objectContaining({ executionStatus: 'stale' }),
    }));
  });

  it('keeps published AI research immutable with a typed error', async () => {
    mocks.researchFindUnique.mockResolvedValue(existing('ai_research', 'published'));
    const res = await put();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'AI_PUBLISHED_IMMUTABLE' });
    expect(mocks.researchUpdate).not.toHaveBeenCalled();
  });
});
