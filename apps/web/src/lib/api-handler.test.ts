import { describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { parseBody, apiHandler } from './api-handler.js';
import { ERROR_CODES } from '@deep-research/shared/errors';

const Schema = z.object({ name: z.string().min(1).max(100), age: z.number().int().min(0) });

function mockReq(body: unknown, contentType = 'application/json'): Request {
  return new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-request-id': 'test-req-id-12345678' },
    body: JSON.stringify(body),
  });
}

describe('parseBody', () => {
  it('returns parsed data on success', async () => {
    const r = await parseBody(mockReq({ name: 'Alice', age: 30 }), Schema);
    expect(r).toEqual({ name: 'Alice', age: 30 });
  });

  it('returns 400 VALIDATION_FAILED when schema fails', async () => {
    const r = await parseBody(mockReq({ name: '', age: -1 }), Schema);
    expect(r).toBeInstanceOf(NextResponse);
    if (r instanceof NextResponse) {
      expect(r.status).toBe(400);
      const body = await r.json();
      expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(body.requestId).toBe('test-req-id-12345678');
    }
  });

  it('returns 400 when body is not JSON', async () => {
    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-12345678' },
      body: 'not json{',
    });
    const r = await parseBody(req, Schema);
    expect(r).toBeInstanceOf(NextResponse);
    if (r instanceof NextResponse) {
      expect(r.status).toBe(400);
      const body = await r.json();
      expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    }
  });
});

describe('apiHandler', () => {
  it('returns handler response on success', async () => {
    const wrapped = apiHandler<[Request]>(async () => NextResponse.json({ ok: true }));
    const res = await wrapped(mockReq({}));
    expect(res.status).toBe(200);
  });

  it('catches thrown Error and returns 500 INTERNAL', async () => {
    const wrapped = apiHandler<[Request]>(async () => {
      throw new Error('boom');
    });
    const res = await wrapped(mockReq({}));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe(ERROR_CODES.INTERNAL);
    expect(body.requestId).toBe('test-req-id-12345678');
  });

  it('passes through NextResponse-throwing helpers', async () => {
    const wrapped = apiHandler<[Request]>(async () => {
      throw NextResponse.json({ code: 'X', message: 'y', requestId: 'z' }, { status: 418 });
    });
    const res = await wrapped(mockReq({}));
    expect(res.status).toBe(418);
  });
});