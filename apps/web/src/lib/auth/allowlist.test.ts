import { describe, expect, it } from 'vitest';
import { isEmailAllowed, isAccountActive, canEstablishSession, domainOf } from './allowlist';

describe('domainOf', () => {
  it('extracts lowercase domain', () => {
    expect(domainOf('Alice@Example.COM')).toBe('example.com');
  });
  it('handles plus addressing and dots', () => {
    expect(domainOf('a.b+c@sub.example.co.uk')).toBe('sub.example.co.uk');
  });
  it('returns empty for malformed', () => {
    expect(domainOf('no-at')).toBe('');
    expect(domainOf('@nohost')).toBe('');
    expect(domainOf('trailing@')).toBe('');
  });
});

describe('isEmailAllowed', () => {
  const allow = ['example.com', 'foo.org'];

  it('matches exact domain', () => {
    expect(isEmailAllowed('a@example.com', allow)).toBe(true);
  });
  it('is case-insensitive on both sides', () => {
    expect(isEmailAllowed('A@EXAMPLE.COM', allow)).toBe(true);
  });
  it('matches subdomain via suffix rule', () => {
    expect(isEmailAllowed('a@a.example.com', allow)).toBe(true);
  });
  it('rejects unrelated domain', () => {
    expect(isEmailAllowed('a@evil.com', allow)).toBe(false);
  });
  it('rejects when allowlist empty', () => {
    expect(isEmailAllowed('a@example.com', [])).toBe(false);
  });
  it('rejects malformed email', () => {
    expect(isEmailAllowed('not-an-email', allow)).toBe(false);
  });
});

describe('isAccountActive', () => {
  it('true when disabledAt is null', () => {
    expect(isAccountActive({ disabledAt: null })).toBe(true);
  });
  it('false when disabledAt is Date', () => {
    expect(isAccountActive({ disabledAt: new Date() })).toBe(false);
  });
  it('false when disabledAt is string', () => {
    expect(isAccountActive({ disabledAt: '2026-07-21T00:00:00Z' })).toBe(false);
  });
  it('false when user is null', () => {
    expect(isAccountActive(null)).toBe(false);
  });
});

describe('canEstablishSession', () => {
  it('allows new user (null existing) so upsert can proceed', () => {
    expect(canEstablishSession(null)).toBe(true);
  });
  it('rejects disabled existing user', () => {
    expect(
      canEstablishSession({ id: 'u', email: 'a@x.com', role: 'member', disabledAt: new Date() }),
    ).toBe(false);
  });
  it('allows active existing user', () => {
    expect(
      canEstablishSession({ id: 'u', email: 'a@x.com', role: 'admin', disabledAt: null }),
    ).toBe(true);
  });
});