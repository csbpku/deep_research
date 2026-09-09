import { describe, expect, it } from 'vitest';
import {
  bootstrapAdminEmail,
  DEFAULT_BOOTSTRAP_ADMIN_EMAIL,
  isBootstrapAdminEmail,
  isInviteCodeValid,
} from './invitation';

describe('invitation access rules', () => {
  it('uses the default bootstrap admin email when unset', () => {
    expect(bootstrapAdminEmail(undefined)).toBe(DEFAULT_BOOTSTRAP_ADMIN_EMAIL);
    expect(isBootstrapAdminEmail(DEFAULT_BOOTSTRAP_ADMIN_EMAIL, '')).toBe(true);
  });

  it('allows explicit bootstrap disable values', () => {
    expect(bootstrapAdminEmail('off')).toBeNull();
    expect(bootstrapAdminEmail('disabled')).toBeNull();
    expect(isBootstrapAdminEmail(DEFAULT_BOOTSTRAP_ADMIN_EMAIL, 'off')).toBe(false);
  });

  it('validates invite codes without accepting blank configuration', () => {
    expect(isInviteCodeValid('invite-2026', 'invite-2026')).toBe(true);
    expect(isInviteCodeValid(' invite-2026 ', 'invite-2026')).toBe(true);
    expect(isInviteCodeValid('wrong', 'invite-2026')).toBe(false);
    expect(isInviteCodeValid('invite-2026', '')).toBe(false);
  });
});
