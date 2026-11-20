import { beforeEach, describe, expect, it, vi } from 'vitest';

const { researchFindUnique, researchUpdate, researchUpdateMany, researchAuditCreate, transitionResearchStatus, queueIndex } = vi.hoisted(() => ({
  researchFindUnique: vi.fn(), researchUpdate: vi.fn(), researchUpdateMany: vi.fn(), researchAuditCreate: vi.fn(), transitionResearchStatus: vi.fn(), queueIndex: vi.fn(),
}));

vi.mock('../../../lib/db', () => ({
  prisma: {
    research: { findUnique: researchFindUnique, update: researchUpdate },
    researchAudit: { create: researchAuditCreate },
    $transaction: (fn: (tx: unknown) => unknown) => fn({
      research: { update: researchUpdate, updateMany: researchUpdateMany },
      researchAudit: { create: researchAuditCreate },
    }),
  },
}));
vi.mock('../../../lib/research-status-actions', () => ({ transitionResearchStatus }));
vi.mock('../../../lib/personal-knowledge-index', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/personal-knowledge-index')>(),
  queuePersonalKnowledgeIndex: queueIndex,
}));
vi.mock('../../../lib/auth/session', () => ({ requireUser: async () => ({ id: 'user-1', role: 'member' }) }));

vi.mock('../../../lib/api-handler', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler')>(),
  apiHandler: (handler: unknown) => handler,
}));
import { POST } from '../researches/[id]/judgement/route';

function req(body: unknown) {
  return new Request('http://localhost/api/researches/x/judgement', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('judgement review endpoint', () => {
  beforeEach(() => {
    researchFindUnique.mockReset(); researchUpdate.mockReset(); researchAuditCreate.mockReset(); transitionResearchStatus.mockReset();
    researchUpdateMany.mockReset(); queueIndex.mockReset();
    researchFindUnique.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111', type: 'knowledge', status: 'published',
      authorId: 'user-1', judgement: 'A claim.', judgementReviewAt: new Date('2026-01-01'),
      title: 'Knowledge card', body: 'Evidence.', conclusion: 'Conclusion.', updatedAt: new Date('2026-11-01'),
      judgementConfidence: 'low', judgementScope: 'Old scope',
    });
    researchUpdate.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', judgementReviewAt: new Date('2027-01-01') });
    researchUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('reaffirms with a future date and writes an audit entry', async () => {
    const response = await POST(req({ action: 'reaffirm', reviewAt: '2027-01-01T00:00:00.000Z' }) as never, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) } as never);
    expect(response.status).toBe(200);
    expect(researchAuditCreate).toHaveBeenCalledTimes(1);
    expect(researchAuditCreate.mock.calls[0][0].data.reason).toContain('仍成立');
  });

  it('rejects a past date', async () => {
    const response = await POST(req({ action: 'reaffirm', reviewAt: '2020-01-01T00:00:00.000Z' }) as never, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) } as never);
    expect(response.status).toBe(400);
    expect(researchUpdate).not.toHaveBeenCalled();
  });

  const revision = {
    action: 'revise', judgement: 'The updated claim is supported.', judgementConfidence: 'high',
    judgementScope: 'Only for the supported configurations.', judgementReviewAt: '2027-01-01T00:00:00.000Z',
  };

  it('revises a published judgement, audits it and queues the new index', async () => {
    const response = await POST(req(revision) as never, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) } as never);
    expect(response.status).toBe(200);
    expect(researchUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'published', updatedAt: new Date('2026-11-01') }),
      data: expect.objectContaining({ judgement: revision.judgement, knowledgeIndexText: expect.stringContaining(revision.judgement) }),
    }));
    expect(researchAuditCreate.mock.calls[0][0].data.diff.judgement).toEqual({ from: 'A claim.', to: revision.judgement });
    expect(queueIndex).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty revised claim', async () => {
    const response = await POST(req({ ...revision, judgement: '' }) as never, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) } as never);
    expect(response.status).toBe(400);
    expect(researchUpdateMany).not.toHaveBeenCalled();
  });

  it('rejects a concurrent edit without writing an audit or index task', async () => {
    researchUpdateMany.mockResolvedValue({ count: 0 });
    const response = await POST(req(revision) as never, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) } as never);
    expect(response.status).toBe(409);
    expect(researchAuditCreate).not.toHaveBeenCalled();
    expect(queueIndex).not.toHaveBeenCalled();
  });
});
