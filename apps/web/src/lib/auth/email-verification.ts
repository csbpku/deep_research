import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const VERIFICATION_CODE_LENGTH = 6;
export const VERIFICATION_TTL_MS = 10 * 60 * 1000;
export const VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;
export const VERIFICATION_MAX_ATTEMPTS = 5;
export const VERIFICATION_MAX_SENDS_PER_IP_HOUR = 10;

export function generateVerificationCode(): string {
  return randomInt(0, 10 ** VERIFICATION_CODE_LENGTH).toString().padStart(VERIFICATION_CODE_LENGTH, '0');
}

export function hashVerificationCode(email: string, code: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`registration:${email.toLowerCase()}:${code}`)
    .digest('hex');
}

export function hashVerificationRequestIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(`registration-ip:${ip}`).digest('hex');
}

export function verificationCodeMatches(actualHash: string, expectedHash: string): boolean {
  const actual = Buffer.from(actualHash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function requestIp(headers: Headers): string {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || 'unknown';
}
