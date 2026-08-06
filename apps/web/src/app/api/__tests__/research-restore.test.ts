import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  researchFindUnique: vi.fn(),
  auditFindFirst: vi.fn(),
  transaction: vi.fn(),
  currentFindUnique: vi.fn(),
  researchUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('../../../lib/auth/session.js', () => ({ requireUser: mocks.requireUser }));
vi.mock('../../../lib/db.js', () => ({
  prisma: {
    research: { findUnique: mocks.researchFindUnique },
    researchAudit: { findFirst: mocks.auditFindFirst },
    $transaction: mocks.transaction,
  },
}));

import { POST } from '../researches/[id]/versions/[versionId]/restore/route';

const USER = { id: '11111111-1111-4111-8111-111111111111', role: 'member' };
const RESEARCH_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
  mocks.researchFindUnique.mockResolvedValue({ id: RESEARCH_ID, authorId: USER.id, status: 'draft' });
  mocks.auditFindFirst.mockResolvedValue({
    id: VERSION_ID,
    prevSnapshot: { title: '旧标题', body: '旧正文', background: null, conclusion: '旧结论', risks: null, tags: ['旧'] },
  });
  mocks.currentFindUnique.mockResolvedValue({ title: '新标题', body: '新正文', background: null, conclusion: null, risks: null, tags: [] });
  mocks.researchUpdate.mockResolvedValue({ id: RESEARCH_ID, title: '旧标题', body: '旧正文', background: null, conclusion: '旧结论', risks: null, tags: ['旧'] });
  mocks.auditCreate.mockResolvedValue({ id: 'revert-audit' });
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    research: { findUnique: mocks.currentFindUnique, update: mocks.researchUpdate },
    researchAudit: { create: mocks.auditCreate },
  }));
});

function request() {
  return POST(
    new Request(`http://localhost/api/researches/${RESEARCH_ID}/versions/${VERSION_ID}/restore`, { method: 'POST' }) as never,
    { params: Promise.resolve({ id: RESEARCH_ID, versionId: VERSION_ID }) },
  );
}

describe('POST research version restore', () => {
  it('restores atomically and creates a revert audit', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.researchUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: RESEARCH_ID }, data: expect.objectContaining({ title: '旧标题', body: '旧正文' }) }));
    expect(mocks.auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ researchId: RESEARCH_ID, editorId: USER.id, action: 'revert', prevSnapshot: expect.objectContaining({ title: '新标题' }) }) });
    await expect(response.json()).resolves.toMatchObject({ ok: true, research: { title: '旧标题', body: '旧正文' } });
  });

  it('does not restore an audit without a snapshot', async () => {
    mocks.auditFindFirst.mockResolvedValueOnce({ id: VERSION_ID, prevSnapshot: null });
    const response = await request();
    expect(response.status).toBe(404);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('hides another user\'s research from restore', async () => {
    mocks.researchFindUnique.mockResolvedValueOnce({ id: RESEARCH_ID, authorId: '44444444-4444-4444-8444-444444444444', status: 'draft' });
    const response = await request();
    expect(response.status).toBe(404);
    expect(mocks.auditFindFirst).not.toHaveBeenCalled();
  });
});
