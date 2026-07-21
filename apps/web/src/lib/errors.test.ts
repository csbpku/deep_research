import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@deep-research/shared/errors';
import type { ErrorCode } from '@deep-research/shared/errors';
import { ERROR_HTTP_STATUS, errorStatus, buildApiError } from './errors.js';

describe('ERROR_HTTP_STATUS mapping', () => {
  it('covers every ERROR_CODES key', () => {
    const codes = Object.values(ERROR_CODES) as ErrorCode[];
    for (const c of codes) {
      expect(ERROR_HTTP_STATUS[c], `missing HTTP status for ${c}`).toBeGreaterThanOrEqual(400);
      expect(ERROR_HTTP_STATUS[c], `missing HTTP status for ${c}`).toBeLessThan(600);
    }
  });

  it('matches contracts/error-codes.md documented statuses', () => {
    expect(ERROR_HTTP_STATUS[ERROR_CODES.AUTH_NOT_AUTHENTICATED]).toBe(401);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.AUTH_DOMAIN_NOT_ALLOWED]).toBe(403);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.AUTH_ACCOUNT_DISABLED]).toBe(403);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.PERMISSION_DENIED]).toBe(403);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.AI_QUOTA_EXCEEDED]).toBe(429);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.AI_ENGINE_UNAVAILABLE]).toBe(503);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.IMPORT_FILE_TOO_LARGE]).toBe(413);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.IMPORT_INVALID_MIME]).toBe(415);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.URL_FETCH_TIMEOUT]).toBe(504);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.URL_REDIRECT_LIMIT]).toBe(502);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.WORKER_LEASE_LOST]).toBe(410);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.ADMIN_ACTION_REQUIRES_CONFIRM]).toBe(412);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.VALIDATION_FAILED]).toBe(400);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.INTERNAL]).toBe(500);
    expect(ERROR_HTTP_STATUS[ERROR_CODES.NOT_IMPLEMENTED]).toBe(501);
  });
});

describe('errorStatus', () => {
  it('returns mapped status for known codes', () => {
    expect(errorStatus(ERROR_CODES.AUTH_NOT_AUTHENTICATED)).toBe(401);
  });
  it('falls back to 500 for unknown code', () => {
    expect(errorStatus('XYZ_NOT_A_REAL_CODE' as ErrorCode)).toBe(500);
  });
});

describe('buildApiError', () => {
  it('omits details when undefined', () => {
    const e = buildApiError({ code: ERROR_CODES.AUTH_NOT_AUTHENTICATED, message: 'm', requestId: 'r' });
    expect(e).toEqual({ code: 'AUTH_NOT_AUTHENTICATED', message: 'm', requestId: 'r' });
    expect('details' in e).toBe(false);
  });
  it('includes details when provided', () => {
    const e = buildApiError({ code: ERROR_CODES.VALIDATION_FAILED, message: 'm', requestId: 'r', details: { x: 1 } });
    expect(e.details).toEqual({ x: 1 });
  });
});