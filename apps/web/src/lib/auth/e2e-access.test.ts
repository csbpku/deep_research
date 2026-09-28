import { describe, expect, it } from 'vitest';
import { canUseE2EProvider, E2E_ADMIN_EMAIL, isAllowedE2EIdentity } from './e2e-access';

describe('E2E authentication boundary', () => {
  const token = 'a'.repeat(64);
  const allowedRequest = {
    nodeEnv: 'development',
    requestUrl: 'http://127.0.0.1:3000/api/auth/callback/e2e-credentials',
    suppliedToken: token,
    expectedToken: token,
  };

  it('requires a development server, a loopback URL, and the per-run token', () => {
    expect(canUseE2EProvider(allowedRequest)).toBe(true);
    expect(canUseE2EProvider({ ...allowedRequest, nodeEnv: 'production' })).toBe(false);
    expect(canUseE2EProvider({ ...allowedRequest, requestUrl: 'https://techradar.top/api/auth/callback/e2e-credentials' })).toBe(false);
    expect(canUseE2EProvider({ ...allowedRequest, suppliedToken: 'wrong' })).toBe(false);
    expect(canUseE2EProvider({ ...allowedRequest, expectedToken: undefined })).toBe(false);
  });

  it('limits E2E identities to the fixed admin and synthetic member domain', () => {
    expect(isAllowedE2EIdentity(E2E_ADMIN_EMAIL, 'admin')).toBe(true);
    expect(isAllowedE2EIdentity(E2E_ADMIN_EMAIL, 'member')).toBe(false);
    expect(isAllowedE2EIdentity('member@e2e.local', 'member')).toBe(true);
    expect(isAllowedE2EIdentity('member@shopee.com', 'member')).toBe(false);
    expect(isAllowedE2EIdentity('e2e-admin@example.com', 'admin')).toBe(false);
    expect(isAllowedE2EIdentity('admin@e2e.local', 'admin')).toBe(false);
  });
});
