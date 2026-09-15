import { describe, expect, it } from 'vitest';

import { effectiveRequestProtocol, isProductionAuthAllowed, isSecureRequest } from './transport';

describe('authentication transport checks', () => {
  it('trusts the reverse proxy scheme over the reconstructed request URL', () => {
    const headers = new Headers({ 'x-forwarded-proto': 'https' });
    expect(effectiveRequestProtocol(headers, 'http://web:3000/api/auth/callback/password')).toBe('https');
    expect(isSecureRequest(new Request('http://web:3000/api/auth/callback/password', { headers }))).toBe(true);
  });

  it('allows local HTTP but rejects production HTTP', () => {
    const headers = new Headers({ 'x-forwarded-proto': 'http' });
    expect(isProductionAuthAllowed(headers, 'development', 'http://localhost:3000/signin')).toBe(true);
    expect(isProductionAuthAllowed(headers, 'production', 'http://120.76.248.204/signin')).toBe(false);
  });

  it('accepts direct HTTPS when no proxy header is present', () => {
    expect(isProductionAuthAllowed(new Headers(), 'production', 'https://research.example.com/signin')).toBe(true);
  });
});
