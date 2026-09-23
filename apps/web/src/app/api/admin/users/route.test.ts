import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  adminActionCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../../../lib/auth/session', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../lib/db', () => ({
  prisma: {
    user: { findUnique: mocks.findUnique },
    $transaction: mocks.transaction,
  },
}));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001', role: 'admin' });
  mocks.findUnique.mockResolvedValue(null);
  mocks.create.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000002',
    email: 'alice@example.com',
  });
  mocks.adminActionCreate.mockResolvedValue({});
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
    user: { create: mocks.create },
    adminAction: { create: mocks.adminActionCreate },
  }));
});

function request(body: unknown): Request {
  return new Request('http://localhost/api/admin/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/users', () => {
  it('pre-creates a member and records the Beta allowlist action', async () => {
    const response = await POST(request({ email: ' Alice@Example.com ' }) as never);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, noop: false, email: 'alice@example.com' });
    expect(mocks.create).toHaveBeenCalledWith({
      data: { email: 'alice@example.com', name: 'alice', role: 'member' },
      select: { id: true, email: true },
    });
    expect(mocks.adminActionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: '00000000-0000-4000-8000-000000000001',
        action: 'user.beta_allowlist_add',
        targetId: '00000000-0000-4000-8000-000000000002',
      }),
    });
  });

  it('is idempotent for an email already in the allowlist', async () => {
    mocks.findUnique.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000002',
      email: 'alice@example.com',
      disabledAt: null,
    });

    const response = await POST(request({ email: 'alice@example.com' }) as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, noop: true, email: 'alice@example.com' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid email input', async () => {
    const response = await POST(request({ email: 'not-an-email' }) as never);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});
