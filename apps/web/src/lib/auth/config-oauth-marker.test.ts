import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('next-auth', () => ({ default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }) }));
vi.mock('next-auth/providers/credentials', () => ({ default: (c: unknown) => c }));
vi.mock('next-auth/providers/github', () => ({ default: (c: unknown) => c }));
vi.mock('next-auth/providers/google', () => ({ default: (c: unknown) => c }));
vi.mock('../db', () => ({ prisma: { user: { findUnique: mocks.findUnique, upsert: mocks.upsert } } }));
vi.mock('./oauth-email', () => ({ isOAuthEmailTrusted: vi.fn().mockResolvedValue(true) }));
vi.mock('../env', () => ({
  getWebEnv: () => ({
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '',
    NEXTAUTH_SECRET: 's', AUTH_GOOGLE_ONLY: false, AUTH_BETA_MODE: false,
    BOOTSTRAP_ADMIN_EMAIL: 'boss@example.com',
  }),
}));

import { authConfig } from './config';

type SignIn = NonNullable<NonNullable<typeof authConfig.callbacks>['signIn']>;
type Jwt = NonNullable<NonNullable<typeof authConfig.callbacks>['jwt']>;

async function login(provider: string, existing: { oauthProviders: string[] } | null) {
  mocks.findUnique.mockResolvedValue(existing ? { id: 'u1', disabledAt: null, ...existing } : null);
  mocks.upsert.mockResolvedValue({ id: 'u1', role: 'member', disabledAt: null });
  const user = { email: 'A@Example.com', name: 'A', image: 'https://x/a.png' };
  const account = { provider, access_token: 't' };
  const ok = await (authConfig.callbacks!.signIn as SignIn)({ user, account, profile: { email: 'a@example.com' } } as never);
  expect(ok).toBe(true);
  await (authConfig.callbacks!.jwt as Jwt)({ token: {}, user, account } as never);
  return mocks.upsert.mock.calls[0]![0];
}

describe('OAuth provider marker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the provider when creating a new user', async () => {
    const arg = await login('google', null);
    expect(arg.create.oauthProviders).toEqual(['google']);
    expect(arg.update.oauthProviders).toEqual({ set: ['google'] });
  });

  it('merges with providers already recorded for an existing user', async () => {
    const arg = await login('github', { oauthProviders: ['google'] });
    expect(arg.update.oauthProviders).toEqual({ set: ['google', 'github'] });
  });

  it('does not duplicate an already recorded provider', async () => {
    const arg = await login('google', { oauthProviders: ['google'] });
    expect(arg.update.oauthProviders).toEqual({ set: ['google'] });
  });

  it('does not touch the marker for non-OAuth sign-ins', async () => {
    mocks.upsert.mockResolvedValue({ id: 'u1', role: 'member', disabledAt: null });
    await (authConfig.callbacks!.jwt as Jwt)({
      token: {}, user: { email: 'a@example.com' }, account: { provider: 'password' },
    } as never);
    const arg = mocks.upsert.mock.calls[0]![0];
    expect(arg.create).not.toHaveProperty('oauthProviders');
    expect(arg.update).not.toHaveProperty('oauthProviders');
  });
});
