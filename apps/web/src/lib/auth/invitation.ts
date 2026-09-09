import { timingSafeEqual } from 'node:crypto';

export const DEFAULT_BOOTSTRAP_ADMIN_EMAIL = 'csbpkuyp@gmail.com';

/**
 * Resolve the bootstrap admin email without making an empty env value disable
 * the safety default. Explicit "off"/"disabled" still disables bootstrap.
 */
export function bootstrapAdminEmail(raw: string | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  if (value === 'off' || value === 'disabled') return null;
  return value || DEFAULT_BOOTSTRAP_ADMIN_EMAIL;
}

export function isBootstrapAdminEmail(email: string, configured: string | undefined): boolean {
  const adminEmail = bootstrapAdminEmail(configured);
  return adminEmail !== null && email.trim().toLowerCase() === adminEmail;
}

/**
 * Compare an activation code without exposing a length-dependent timing signal.
 * Empty configuration intentionally makes every activation attempt invalid.
 */
export function isInviteCodeValid(input: string, configured: string): boolean {
  const actual = input.trim();
  const expected = configured.trim();
  if (!actual || !expected) return false;

  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}
