import { afterEach, describe, expect, it } from 'vitest';
import { clientIp, rateLimitKey } from './client-ip';

afterEach(() => { delete process.env.TRUSTED_PROXY_HOPS; });

describe('clientIp', () => {
  it('prefers x-real-ip and ignores spoofed XFF', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '198.51.100.8', 'x-forwarded-for': '1.1.1.1' }))).toBe('198.51.100.8');
    expect(clientIp(new Headers({ 'x-forwarded-for': '1.1.1.1, 10.0.0.1' }))).toBe('unknown');
  });
  it('uses the Nth-from-last XFF entry only when TRUSTED_PROXY_HOPS is set', () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    expect(clientIp(new Headers({ 'x-forwarded-for': 'spoofed, 203.0.113.9' }))).toBe('203.0.113.9');
  });
  it('keys by user when authenticated', () => {
    expect(rateLimitKey(new Headers(), 'u1')).toBe('user:u1');
    expect(rateLimitKey(new Headers({ 'x-real-ip': '1.2.3.4' }))).toBe('ip:1.2.3.4');
  });
});
