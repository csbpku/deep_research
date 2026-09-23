import { describe, expect, it } from 'vitest';
import {
  generateVerificationCode,
  hashVerificationCode,
  requestIp,
  verificationCodeMatches,
} from './email-verification';

describe('email verification helpers', () => {
  it('generates a zero-padded six-digit code', () => {
    expect(generateVerificationCode()).toMatch(/^\d{6}$/);
  });

  it('binds the code hash to the normalized email and secret', () => {
    const hash = hashVerificationCode('Alice@Example.com', '123456', 'secret');
    expect(hash).toBe(hashVerificationCode('alice@example.com', '123456', 'secret'));
    expect(verificationCodeMatches(hash, hash)).toBe(true);
    expect(verificationCodeMatches(hash, hashVerificationCode('alice@example.com', '654321', 'secret'))).toBe(false);
  });

  it('uses the first forwarded client address', () => {
    expect(requestIp(new Headers({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }))).toBe('203.0.113.5');
    expect(requestIp(new Headers({
      'x-real-ip': '198.51.100.8',
      'x-forwarded-for': 'spoofed, 10.0.0.1',
    }))).toBe('198.51.100.8');
  });
});
