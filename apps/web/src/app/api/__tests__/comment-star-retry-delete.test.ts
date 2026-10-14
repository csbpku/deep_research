import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '11111111-1111-4111-8111-111111111111';
const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  getCurrentUser: vi.fn(),
  starDeleteMany: vi.fn(),
  commentUpdate: vi.fn(),
  commentFindUnique: vi.fn(),
  commentDelete: vi.fn(),
  commentCount: vi.fn(),
  researchUpdate: vi.fn(),
  writeAdminAction: vi.fn(),
  subFindUnique: vi.fn(),
  subUpdateMany: vi.fn(),
  adminActionCreate: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({
  requireUser: mocks.requireUser,
  requireAdmin: mocks.requireAdmin,
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock('@/lib/radar/admin-actions', () => ({ newAdminActionRequestId: () => 'r', writeAdminAction: mocks.writeAdminAction }));
vi.mock('@/lib/radar/submissions/worker-bridge', () => ({ enqueueRadarSubmission: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/db', () => {
  const tx = {
    commentStar: { deleteMany: mocks.starDeleteMany },
    comment: { update: mocks.commentUpdate, delete: mocks.commentDelete, count: mocks.commentCount },
    research: { update: mocks.researchUpdate },
    radarSubmission: { findUnique: mocks.subFindUnique, updateMany: mocks.subUpdateMany },
  };
  return {
    prisma: {
      comment: { findUnique: mocks.commentFindUnique },
      adminAction: { create: mocks.adminActionCreate },
      $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    },
  };
});

import { DELETE as unstar } from '../comments/[id]/star/route';
import { DELETE as deleteComment } from '../comments/[id]/route';
import { POST as retry } from '../admin/radar/submissions/[id]/retry/route';

const ctx = { params: Promise.resolve({ id: ID }) };
const req = (method: string) => new Request(`http://localhost/api/x/${ID}`, { method }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: 'u', role: 'member' });
  mocks.requireAdmin.mockResolvedValue({ id: 'a', role: 'admin' });
  mocks.commentFindUnique.mockResolvedValue({ starCount: 0 });
});

describe('DELETE /api/comments/[id]/star', () => {
  it('is idempotent under a concurrent unstar (no row deleted -> no decrement, no error)', async () => {
    mocks.starDeleteMany.mockResolvedValue({ count: 0 });
    const res = await unstar(req('DELETE'), ctx);
    expect(res.status).toBe(200);
    expect(mocks.commentUpdate).not.toHaveBeenCalled();
  });
  it('decrements once when a row was removed', async () => {
    mocks.starDeleteMany.mockResolvedValue({ count: 1 });
    expect((await unstar(req('DELETE'), ctx)).status).toBe(200);
    expect(mocks.commentUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { starCount: { decrement: 1 } } }));
  });
});

describe('POST /api/admin/radar/submissions/[id]/retry', () => {
  it('does not mask real database errors as a 400', async () => {
    mocks.subFindUnique.mockRejectedValue(new Error('connection reset'));
    await expect(retry(req('POST'), ctx)).rejects.toThrow('connection reset');
  });
  it('maps non-failed status to 400 and missing to 404', async () => {
    mocks.subFindUnique.mockResolvedValueOnce({ id: ID, status: 'completed', submitterId: 'u' });
    expect((await retry(req('POST'), ctx)).status).toBe(400);
    mocks.subFindUnique.mockResolvedValueOnce(null);
    expect((await retry(req('POST'), ctx)).status).toBe(404);
  });
});

describe('DELETE /api/comments/[id] reply semantics', () => {
  it('audits replies as orphaned (SetNull), not as deleted children', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'a', role: 'admin' });
    mocks.commentFindUnique.mockResolvedValue({
      id: ID, authorId: 'someone', researchId: null, summaryId: ID, targetType: 'summary', parentId: null,
      _count: { children: 2, stars: 1 },
    });
    const res = await deleteComment(req('DELETE'), ctx);
    expect(res.status).toBe(200);
    const meta = mocks.writeAdminAction.mock.calls[0]![1].metadata;
    expect(meta).toMatchObject({ orphanedReplyCount: 2 });
    expect(meta).not.toHaveProperty('childCount');
  });
});
