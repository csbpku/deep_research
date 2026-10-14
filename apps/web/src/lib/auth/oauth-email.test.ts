import { describe, expect, it } from 'vitest';
import { isGithubEmailVerified, isGoogleEmailVerified, isOAuthEmailTrusted } from './oauth-email';

describe('oauth email trust', () => {
  it('google requires email_verified === true', () => {
    expect(isGoogleEmailVerified({ email_verified: true })).toBe(true);
    for (const v of [false, undefined, 'true', 1]) expect(isGoogleEmailVerified({ email_verified: v })).toBe(false);
    expect(isGoogleEmailVerified(null)).toBe(false);
  });

  it('github requires the chosen email to be verified', () => {
    const entries = [
      { email: 'Victim@x.test', verified: false, primary: true },
      { email: 'me@x.test', verified: true, primary: false },
    ];
    expect(isGithubEmailVerified(entries, 'victim@x.test')).toBe(false);
    expect(isGithubEmailVerified(entries, 'ME@x.test')).toBe(true);
    expect(isGithubEmailVerified(entries, 'other@x.test')).toBe(false);
    expect(isGithubEmailVerified('nope', 'me@x.test')).toBe(false);
  });

  it('rejects github when the token is missing or the lookup fails; passes other providers', async () => {
    expect(await isOAuthEmailTrusted({ provider: 'github', email: 'a@x.test' })).toBe(false);
    expect(await isOAuthEmailTrusted({ provider: 'github', email: 'a@x.test', accessToken: 't', fetchEmails: async () => null })).toBe(false);
    expect(await isOAuthEmailTrusted({
      provider: 'github', email: 'a@x.test', accessToken: 't',
      fetchEmails: async () => [{ email: 'a@x.test', verified: true }],
    })).toBe(true);
    expect(await isOAuthEmailTrusted({ provider: 'password', email: 'a@x.test' })).toBe(true);
  });
});
