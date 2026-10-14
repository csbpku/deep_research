import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), findMany: vi.fn(), count: vi.fn() }));
vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/db', () => ({ prisma: { radarSubmission: { findMany: mocks.findMany, count: mocks.count } } }));
vi.mock('@/lib/radar/submissions/worker-bridge', () => ({ enqueueRadarSubmission: vi.fn() }));

import { GET } from '../radar/submissions/route';

const get = (qs: string) => GET(new Request(`http://localhost/api/radar/submissions${qs}`) as never);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: 'u1', role: 'member' });
  mocks.findMany.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
});

describe('GET /api/radar/submissions validation', () => {
  it.each(['?page=abc', '?page=-1', '?page=1.5', '?status=bogus'])('returns 400 for %s', async (qs) => {
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('accepts valid page and status', async () => {
    const res = await get('?page=2&status=failed');
    expect(res.status).toBe(200);
    expect(mocks.findMany.mock.calls[0]![0]).toMatchObject({ skip: 20, where: { status: 'failed' } });
  });
});
