import { timingSafeEqual } from 'node:crypto';

export const E2E_ADMIN_EMAIL = 'e2e-admin@e2e.local';

export function isAllowedE2EIdentity(email: string, role: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (normalized !== email) return false;
  if (normalized === E2E_ADMIN_EMAIL) return role === 'admin';
  return role === 'member' && /^[a-z0-9][a-z0-9._+-]*@e2e\.local$/.test(normalized);
}

export function canUseE2EProvider(input: {
  nodeEnv: string | undefined;
  requestUrl: string;
  suppliedToken: string | undefined;
  expectedToken: string | undefined;
}): boolean {
  if (input.nodeEnv !== 'development') return false;
  if (!input.expectedToken || input.expectedToken.length < 32 || !input.suppliedToken) return false;

  let hostname: string;
  try {
    hostname = new URL(input.requestUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return false;

  const supplied = Buffer.from(input.suppliedToken);
  const expected = Buffer.from(input.expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
