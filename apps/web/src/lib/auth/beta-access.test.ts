import { describe, expect, it } from 'vitest';
import { canCreateAccountInBeta } from './beta-access';

const base = {
  email: 'alice@example.com',
  existingUser: null,
  bootstrapAdminEmail: 'admin@example.com',
};

describe('canCreateAccountInBeta', () => {
  it('keeps public account creation open when Beta mode is off', () => {
    expect(canCreateAccountInBeta({ ...base, betaMode: false })).toBe(true);
  });

  it('rejects an unknown email when Beta mode is on', () => {
    expect(canCreateAccountInBeta({ ...base, betaMode: true })).toBe(false);
  });

  it('allows a pre-created user and the bootstrap Admin in Beta mode', () => {
    expect(canCreateAccountInBeta({ ...base, betaMode: true, existingUser: { id: 'invited' } })).toBe(true);
    expect(canCreateAccountInBeta({
      ...base,
      betaMode: true,
      email: 'ADMIN@example.com',
    })).toBe(true);
  });
});
