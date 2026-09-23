import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWebEnv: vi.fn(),
  userFindUnique: vi.fn(),
  challengeFindUnique: vi.fn(),
  challengeCount: vi.fn(),
  challengeCreate: vi.fn(),
  challengeUpdateMany: vi.fn(),
  challengeDeleteMany: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/env', () => ({ getWebEnv: mocks.getWebEnv }));
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    emailVerificationChallenge: {
      findUnique: mocks.challengeFindUnique,
      count: mocks.challengeCount,
      create: mocks.challengeCreate,
      updateMany: mocks.challengeUpdateMany,
      deleteMany: mocks.challengeDeleteMany,
    },
  },
}));
vi.mock('@/lib/auth/verification-mailer', () => ({
  sendRegistrationVerificationEmail: mocks.sendEmail,
}));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWebEnv.mockReturnValue({
    NODE_ENV: 'test',
    AUTH_GOOGLE_ONLY: false,
    AUTH_BETA_MODE: false,
    AUTH_EMAIL_VERIFICATION: true,
    AUTH_ALLOW_INSECURE_HTTP: false,
    BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
    NEXTAUTH_SECRET: 'verification-secret',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    SMTP_USER: 'mailer',
    SMTP_PASSWORD: 'password',
    SMTP_FROM: 'noreply@example.com',
  });
  mocks.userFindUnique.mockResolvedValue(null);
  mocks.challengeFindUnique.mockResolvedValue(null);
  mocks.challengeCount.mockResolvedValue(0);
  mocks.challengeCreate.mockResolvedValue({ id: 'challenge-1' });
  mocks.challengeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.challengeDeleteMany.mockResolvedValue({ count: 1 });
  mocks.sendEmail.mockResolvedValue(undefined);
});

function request(email: string): Request {
  return new Request('http://localhost/api/auth/verification/send', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.5',
    },
    body: JSON.stringify({ email }),
  });
}

describe('POST /api/auth/verification/send', () => {
  it('stores an HMAC challenge and sends the code', async () => {
    const response = await POST(request('Alice@Example.com'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, expiresInSeconds: 600 });
    expect(mocks.challengeCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: 'alice@example.com',
        codeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        requestIpHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      'alice@example.com',
      expect.stringMatching(/^\d{6}$/),
      expect.objectContaining({ SMTP_HOST: 'smtp.example.com' }),
    );
  });

  it('enforces the per-email resend cooldown', async () => {
    mocks.challengeFindUnique.mockResolvedValue({ sentAt: new Date() });
    const response = await POST(request('alice@example.com'));
    expect(response.status).toBe(429);
    expect((await response.json()).code).toBe('AUTH_VERIFICATION_RATE_LIMITED');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('atomically reserves an expired resend window', async () => {
    mocks.challengeFindUnique.mockResolvedValue({
      id: 'challenge-1',
      sentAt: new Date(Date.now() - 120_000),
    });
    const response = await POST(request('alice@example.com'));
    expect(response.status).toBe(200);
    expect(mocks.challengeUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'challenge-1',
        sentAt: { lte: expect.any(Date) },
      },
      data: expect.objectContaining({ attempts: 0, consumedAt: null }),
    });
    expect(mocks.challengeCreate).not.toHaveBeenCalled();
  });

  it('does not send to an unknown email in Beta mode', async () => {
    mocks.getWebEnv.mockReturnValue({
      ...mocks.getWebEnv(),
      AUTH_BETA_MODE: true,
    });
    const response = await POST(request('unknown@example.com'));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('AUTH_REGISTRATION_DISABLED');
    expect(mocks.challengeCreate).not.toHaveBeenCalled();
  });

  it('removes the reserved challenge when SMTP delivery fails', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('smtp unavailable'));
    const response = await POST(request('alice@example.com'));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('AUTH_EMAIL_DELIVERY_FAILED');
    expect(mocks.challengeDeleteMany).toHaveBeenCalledWith({
      where: { id: 'challenge-1', codeHash: expect.any(String) },
    });
  });
});
