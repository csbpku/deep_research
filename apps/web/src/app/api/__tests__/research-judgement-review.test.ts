import { beforeEach, describe, expect, it, vi } from 'vitest';

const { researchFindUnique, researchUpdate, researchAuditCreate, transitionResearchStatus } = vi.hoisted(() => ({
  researchFindUnique: vi.fn(), researchUpdate: vi.fn(), researchAuditCreate: vi.fn(), transitionResearchStatus: vi.fn(),
}));

vi.mock('../../../lib/db', () => ({
  prisma: {
    research: { findUnique: researchFindUnique, update: researchUpdate },
    researchAudit: { create: researchAuditCreate },
    $transaction: (fn: (tx: unknown) => unknown) => fn({
      research: { update: researchUpdate },
      researchAudit: { create: researchAuditCreate },
    }),
  },
}));
vi.mock('../../../lib/research-status-actions', () => ({ transitionResearchStatus }));
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
    researchFindUnique.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111', type: 'knowledge', status: 'published',
      authorId: 'user-1', judgement: 'A claim.', judgementReviewAt: new Date('2026-01-01'),
    });
    researchUpdate.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', judgementReviewAt: new Date('2027-01-01') });
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

  it('returns the edit target for revise', async () => {
    const response = await POST(req({ action: 'revise' }) as never, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) } as never);
    await expect(response.json()).resolves.toMatchObject({ redirectTo: expect.stringContaining('/edit') });
  });
});
