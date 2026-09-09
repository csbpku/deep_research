import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  hashPassword: vi.fn(),
  getWebEnv: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: mocks.findUnique,
      create: mocks.create,
      update: mocks.update,
    },
  },
}));
vi.mock('@/lib/auth/password', () => ({
  hashPassword: mocks.hashPassword,
  PASSWORD_MIN_LENGTH: 12,
  PASSWORD_MAX_LENGTH: 256,
}));
vi.mock('@/lib/env', () => ({ getWebEnv: mocks.getWebEnv }));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWebEnv.mockReturnValue({
    ALLOWED_EMAIL_DOMAINS: ['example.com', 'gmail.com'],
    AUTH_INVITE_CODE: 'invite-2026',
    BOOTSTRAP_ADMIN_EMAIL: 'csbpkuyp@gmail.com',
  });
  mocks.hashPassword.mockResolvedValue('scrypt$16384$8$1$salt$hash');
  mocks.findUnique.mockResolvedValue(null);
  mocks.create.mockResolvedValue({ id: 'user-1', role: 'member' });
  mocks.update.mockResolvedValue({ id: 'user-1', role: 'admin' });
});

function request(body: unknown): Request {
  return new Request('http://localhost/api/auth/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/activate', () => {
  it('creates an allowlisted member with the correct invite code', async () => {
    const response = await POST(
      request({
        email: ' Alice@Example.com ',
        name: 'Alice',
        inviteCode: 'invite-2026',
        password: 'correct horse battery staple',
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ ok: true, role: 'member' });
    expect(mocks.hashPassword).toHaveBeenCalledWith('correct horse battery staple');
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        email: 'alice@example.com',
        name: 'Alice',
        passwordHash: 'scrypt$16384$8$1$salt$hash',
        role: 'member',
      },
      select: { id: true, role: true },
    });
  });

  it('creates the default bootstrap admin as admin', async () => {
    mocks.create.mockResolvedValueOnce({ id: 'user-1', role: 'admin' });
    const response = await POST(
      request({
        email: 'csbpkuyp@gmail.com',
        inviteCode: 'invite-2026',
        password: 'correct horse battery staple',
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, role: 'admin' });
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'csbpkuyp@gmail.com',
        role: 'admin',
      }),
      select: { id: true, role: true },
    });
  });

  it('sets the password for a bootstrapped admin without a password', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'bootstrap-admin',
      passwordHash: null,
      disabledAt: null,
    });

    const response = await POST(
      request({
        email: 'csbpkuyp@gmail.com',
        inviteCode: 'invite-2026',
        password: 'correct horse battery staple',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, role: 'admin' });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'bootstrap-admin' },
      data: {
        passwordHash: 'scrypt$16384$8$1$salt$hash',
        role: 'admin',
      },
      select: { id: true, role: true },
    });
  });

  it('rejects an invalid invite code before reading the user', async () => {
    const response = await POST(
      request({
        email: 'alice@example.com',
        inviteCode: 'wrong-code',
        password: 'correct horse battery staple',
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('AUTH_INVITE_INVALID');
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.hashPassword).not.toHaveBeenCalled();
  });

  it('rejects an email outside the allowlist', async () => {
    const response = await POST(
      request({
        email: 'alice@other.example',
        inviteCode: 'invite-2026',
        password: 'correct horse battery staple',
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('AUTH_DOMAIN_NOT_ALLOWED');
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing password', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'existing-user',
      passwordHash: 'already-hashed',
      disabledAt: null,
    });

    const response = await POST(
      request({
        email: 'alice@example.com',
        inviteCode: 'invite-2026',
        password: 'correct horse battery staple',
      }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('AUTH_ACCOUNT_EXISTS');
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects disabled accounts', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'disabled-user',
      passwordHash: null,
      disabledAt: new Date('2026-09-01T00:00:00Z'),
    });

    const response = await POST(
      request({
        email: 'alice@example.com',
        inviteCode: 'invite-2026',
        password: 'correct horse battery staple',
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('AUTH_ACCOUNT_DISABLED');
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
