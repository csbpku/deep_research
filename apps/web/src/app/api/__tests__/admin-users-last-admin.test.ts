import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  order: [] as string[],
  count: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  adminActionCreate: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({
      $queryRaw: async () => { mocks.order.push('lock'); return []; },
      user: {
        findUnique: mocks.findUnique,
        count: async (...a: unknown[]) => { mocks.order.push('count'); return mocks.count(...a); },
        update: mocks.update,
      },
      adminAction: { create: mocks.adminActionCreate },
    }),
  },
}));

import { PUT } from '../admin/users/[id]/route';

const put = (body: unknown) => PUT(new Request(`http://localhost/api/admin/users/${TARGET}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}) as never, { params: Promise.resolve({ id: TARGET }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.order.length = 0;
  mocks.requireAdmin.mockResolvedValue({ id: ACTOR, role: 'admin' });
  mocks.findUnique.mockResolvedValue({ id: TARGET, role: 'admin', disabledAt: null, email: 'a@x.test', name: 'a' });
});

describe('PUT /api/admin/users/[id] last-admin guard', () => {
  it('takes the advisory lock before counting active admins', async () => {
    mocks.count.mockResolvedValue(1);
    const res = await put({ role: 'member' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mocks.order).toEqual(['lock', 'count']);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('allows demotion when another active admin exists', async () => {
    mocks.count.mockResolvedValue(2);
    mocks.update.mockResolvedValue({ id: TARGET, role: 'member', disabledAt: null, email: 'a@x.test', name: 'a' });
    const res = await put({ role: 'member' });
    expect(res.status).toBe(200);
    expect(mocks.order[0]).toBe('lock');
  });
});
