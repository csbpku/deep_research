import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '11111111-1111-4111-8111-111111111111';
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  shareFind: vi.fn(),
  shareUpdateMany: vi.fn(),
  shareUpdate: vi.fn(),
  summaryFind: vi.fn(),
  summaryCreate: vi.fn(),
  commentFind: vi.fn(),
  commentUpdateMany: vi.fn(),
  researchCreate: vi.fn(),
  writeAdminAction: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/radar/admin-actions', () => ({
  newAdminActionRequestId: () => 'req',
  writeAdminAction: mocks.writeAdminAction,
}));
vi.mock('@/lib/db', () => {
  const tx = {
    shareSubmission: { updateMany: mocks.shareUpdateMany, update: mocks.shareUpdate },
    summary: { findUnique: mocks.summaryFind, create: mocks.summaryCreate },
    comment: { updateMany: mocks.commentUpdateMany },
    research: { create: mocks.researchCreate },
  };
  return {
    prisma: {
      shareSubmission: { findUnique: mocks.shareFind },
      comment: { findUnique: mocks.commentFind },
      $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    },
  };
});

import { POST as reviewShare } from '../admin/shares/[id]/review/route';
import { POST as promote } from '../admin/comments/[id]/promote/route';
import { POST as dismiss } from '../admin/comments/[id]/dismiss/route';

const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}) as never;
const ctx = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue({ id: 'admin', role: 'admin' });
});

describe('admin share review', () => {
  const share = {
    id: ID, status: 'pending', url: 'https://x.test/a', canonicalUrl: 'https://x.test/a', userNote: null,
    fetchedTitle: 't', fetchedMarkdown: 'md', summaryText: 'sum', submitterId: 'u', contentSha256: null,
  };

  it('links to the existing summary instead of failing on a duplicate canonicalUrl', async () => {
    mocks.shareFind.mockResolvedValue(share);
    mocks.shareUpdateMany.mockResolvedValue({ count: 1 });
    mocks.summaryFind.mockResolvedValue({ id: 'existing-summary' });
    const res = await reviewShare(post('/x', { action: 'approve' }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ summaryId: 'existing-summary' });
    expect(mocks.summaryCreate).not.toHaveBeenCalled();
    expect(mocks.shareUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { publishedSummaryId: 'existing-summary' } }));
  });

  it('claims with a pending precondition and rejects a lost race without side effects', async () => {
    mocks.shareFind.mockResolvedValue(share);
    mocks.shareUpdateMany.mockResolvedValue({ count: 0 });
    const res = await reviewShare(post('/x', { action: 'approve' }), ctx);
    expect(res.status).toBe(400);
    expect(mocks.shareUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ID, status: 'pending' } }));
    expect(mocks.summaryCreate).not.toHaveBeenCalled();
    expect(mocks.writeAdminAction).not.toHaveBeenCalled();
  });
});

describe('admin comment promote/dismiss', () => {
  const comment = { id: ID, promoteStatus: 'nominated', targetType: 'summary', summaryId: null, researchId: null, body: 'b' };

  it('does not create a duplicate knowledge entry when the status was already claimed', async () => {
    mocks.commentFind.mockResolvedValue(comment);
    mocks.commentUpdateMany.mockResolvedValue({ count: 0 });
    const res = await promote(post('/x', { title: 'Title here', body: 'Body content long enough', tags: [] }), ctx);
    expect(res.status).toBe(400);
    expect(mocks.researchCreate).not.toHaveBeenCalled();
  });

  it('dismiss is a conditional transition too', async () => {
    mocks.commentFind.mockResolvedValue(comment);
    mocks.commentUpdateMany.mockResolvedValue({ count: 0 });
    const res = await dismiss(post('/x', { reason: 'no' }), ctx);
    expect(res.status).toBe(400);
    expect(mocks.writeAdminAction).not.toHaveBeenCalled();
  });
});
