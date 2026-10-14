import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), findMany: vi.fn() }));
vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/db', () => ({ prisma: { user: { findMany: mocks.findMany } } }));

import { GET } from '../team-members/route';

const get = (q = '') => GET(new Request(`http://localhost/api/team-members?q=${q}`) as never);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.findMany.mockResolvedValue([{ id: 'u2', name: 'Bob', email: 'bob@example.com', avatarUrl: null }]);
});

describe('GET /api/team-members', () => {
  it('masks emails and does not search by email for members', async () => {
    mocks.requireUser.mockResolvedValue({ id: 'u1', role: 'member' });
    const body = await (await get('bo')).json();
    expect(body.items[0]).toMatchObject({ id: 'u2', name: 'Bob', email: 'b***@example.com' });
    const where = mocks.findMany.mock.calls[0]![0].where;
    expect(JSON.stringify(where)).not.toContain('"email":{"contains"');
  });

  it('returns full emails to admins', async () => {
    mocks.requireUser.mockResolvedValue({ id: 'u1', role: 'admin' });
    const body = await (await get('bo')).json();
    expect(body.items[0].email).toBe('bob@example.com');
  });
});
