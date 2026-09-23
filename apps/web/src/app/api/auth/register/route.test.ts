import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  challengeFindUnique: vi.fn(),
  challengeUpdateMany: vi.fn(),
  transaction: vi.fn(),
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
    emailVerificationChallenge: {
      findUnique: mocks.challengeFindUnique,
      updateMany: mocks.challengeUpdateMany,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/auth/password', () => ({
  hashPassword: mocks.hashPassword,
  PASSWORD_MIN_LENGTH: 12,
  PASSWORD_MAX_LENGTH: 256,
}));
vi.mock('@/lib/env', () => ({ getWebEnv: mocks.getWebEnv }));

import { POST } from './route';
import { hashVerificationCode } from '@/lib/auth/email-verification';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWebEnv.mockReturnValue({
    NODE_ENV: 'test',
    ALLOWED_EMAIL_DOMAINS: [],
    AUTH_GOOGLE_ONLY: false,
    AUTH_BETA_MODE: false,
    AUTH_EMAIL_VERIFICATION: false,
    AUTH_ALLOW_INSECURE_HTTP: false,
    BOOTSTRAP_ADMIN_EMAIL: 'shaobo.chen@shopee.com',
    NEXTAUTH_SECRET: 'test-verification-secret',
  });
  mocks.hashPassword.mockResolvedValue('scrypt$16384$8$1$salt$hash');
  mocks.findUnique.mockResolvedValue(null);
  mocks.create.mockResolvedValue({ id: 'user-1', role: 'member' });
  mocks.update.mockResolvedValue({ id: 'user-1', role: 'member' });
  mocks.challengeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
    user: { create: mocks.create, update: mocks.update },
    emailVerificationChallenge: { updateMany: mocks.challengeUpdateMany },
  }));
});

function request(body: unknown, url = 'http://localhost/api/auth/register'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/register', () => {
  it('creates a member without an email domain allowlist', async () => {
    const response = await POST(
      request({
        email: ' Alice@Example.com ',
        name: 'Alice',
        password: 'correct horse battery staple',
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, role: 'member' });
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

  it('creates the bootstrap admin directly through registration', async () => {
    mocks.create.mockResolvedValueOnce({ id: 'user-1', role: 'admin' });

    const response = await POST(
      request({
        email: 'shaobo.chen@shopee.com',
        password: 'correct horse battery staple',
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, role: 'admin' });
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'shaobo.chen@shopee.com',
        role: 'admin',
      }),
      select: { id: true, role: true },
    });
  });

  it('sets a password for an existing OAuth-only account', async () => {
    mocks.getWebEnv.mockReturnValue({
      NODE_ENV: 'test',
      ALLOWED_EMAIL_DOMAINS: [],
      AUTH_GOOGLE_ONLY: false,
      AUTH_BETA_MODE: true,
      AUTH_EMAIL_VERIFICATION: false,
      AUTH_ALLOW_INSECURE_HTTP: false,
      BOOTSTRAP_ADMIN_EMAIL: 'shaobo.chen@shopee.com',
      NEXTAUTH_SECRET: 'test-verification-secret',
    });
    mocks.findUnique.mockResolvedValue({
      id: 'oauth-user',
      passwordHash: null,
      disabledAt: null,
    });

    const response = await POST(
      request({
        email: 'alice@example.com',
        name: 'Alice Updated',
        password: 'correct horse battery staple',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, role: 'member' });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'oauth-user' },
      data: {
        passwordHash: 'scrypt$16384$8$1$salt$hash',
        name: 'Alice Updated',
      },
      select: { id: true, role: true },
    });
  });

  it('rejects an existing password account', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'existing-user',
      passwordHash: 'already-hashed',
      disabledAt: null,
    });

    const response = await POST(
      request({
        email: 'alice@other.example',
        password: 'correct horse battery staple',
      }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('AUTH_ACCOUNT_EXISTS');
    expect(mocks.hashPassword).not.toHaveBeenCalled();
  });

  it('requires and atomically consumes a valid email verification code', async () => {
    const secret = 'test-verification-secret';
    const codeHash = hashVerificationCode('alice@example.com', '123456', secret);
    mocks.getWebEnv.mockReturnValue({
      NODE_ENV: 'test',
      AUTH_GOOGLE_ONLY: false,
      AUTH_BETA_MODE: false,
      AUTH_EMAIL_VERIFICATION: true,
      AUTH_ALLOW_INSECURE_HTTP: false,
      BOOTSTRAP_ADMIN_EMAIL: 'shaobo.chen@shopee.com',
      NEXTAUTH_SECRET: secret,
    });
    mocks.challengeFindUnique.mockResolvedValue({
      id: 'challenge-1',
      codeHash,
      attempts: 0,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });

    const response = await POST(request({
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      verificationCode: '123456',
    }));

    expect(response.status).toBe(201);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.challengeUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        email: 'alice@example.com',
        codeHash,
        consumedAt: null,
      }),
      data: { consumedAt: expect.any(Date) },
    });
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('counts a wrong verification attempt and rejects registration', async () => {
    const secret = 'test-verification-secret';
    mocks.getWebEnv.mockReturnValue({
      NODE_ENV: 'test',
      AUTH_GOOGLE_ONLY: false,
      AUTH_BETA_MODE: false,
      AUTH_EMAIL_VERIFICATION: true,
      AUTH_ALLOW_INSECURE_HTTP: false,
      BOOTSTRAP_ADMIN_EMAIL: 'shaobo.chen@shopee.com',
      NEXTAUTH_SECRET: secret,
    });
    mocks.challengeFindUnique.mockResolvedValue({
      id: 'challenge-1',
      codeHash: hashVerificationCode('alice@example.com', '123456', secret),
      attempts: 0,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });

    const response = await POST(request({
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      verificationCode: '654321',
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('AUTH_VERIFICATION_INVALID');
    expect(mocks.challengeUpdateMany).toHaveBeenCalledWith({
      where: { id: 'challenge-1', consumedAt: null, attempts: { lt: 5 } },
      data: { attempts: { increment: 1 } },
    });
    expect(mocks.hashPassword).not.toHaveBeenCalled();
  });

  it('rejects an unknown email when Beta mode is enabled', async () => {
    mocks.getWebEnv.mockReturnValue({
      NODE_ENV: 'test',
      ALLOWED_EMAIL_DOMAINS: [],
      AUTH_GOOGLE_ONLY: false,
      AUTH_BETA_MODE: true,
      AUTH_EMAIL_VERIFICATION: false,
      AUTH_ALLOW_INSECURE_HTTP: false,
      BOOTSTRAP_ADMIN_EMAIL: 'shaobo.chen@shopee.com',
      NEXTAUTH_SECRET: 'test-verification-secret',
    });

    const response = await POST(
      request({
        email: 'not-invited@example.com',
        password: 'correct horse battery staple',
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: 'AUTH_REGISTRATION_DISABLED',
      message: '当前为 Beta 测试，仅限管理员白名单中的邮箱注册',
    });
    expect(mocks.hashPassword).not.toHaveBeenCalled();
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
        password: 'correct horse battery staple',
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('AUTH_ACCOUNT_DISABLED');
    expect(mocks.hashPassword).not.toHaveBeenCalled();
  });

  it('rejects invalid input', async () => {
    const response = await POST(
      request({
        email: 'not-an-email',
        password: 'short',
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it('keeps public registration disabled in legacy Google-only mode', async () => {
    mocks.getWebEnv.mockReturnValue({
      NODE_ENV: 'production',
      ALLOWED_EMAIL_DOMAINS: [],
      AUTH_GOOGLE_ONLY: true,
      AUTH_BETA_MODE: false,
      AUTH_EMAIL_VERIFICATION: false,
      AUTH_ALLOW_INSECURE_HTTP: false,
      BOOTSTRAP_ADMIN_EMAIL: 'shaobo.chen@shopee.com',
      NEXTAUTH_SECRET: 'test-verification-secret',
    });

    const response = await POST(
      request({
        email: 'alice@example.com',
        password: 'correct horse battery staple',
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('AUTH_REGISTRATION_DISABLED');
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});
