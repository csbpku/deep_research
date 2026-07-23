import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { log, withRequestId, serializeError } from './log';

describe('log', () => {
  let stdout: string[] = [];
  const originalWrite = process.stdout.write;

  beforeEach(() => {
    stdout = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('emits a single JSON line with ts/level/scope/msg', () => {
    log.info('test.scope', 'hello', { foo: 1 });
    expect(stdout).toHaveLength(1);
    const line = stdout[0].replace(/\n$/, '');
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('info');
    expect(parsed.scope).toBe('test.scope');
    expect(parsed.msg).toBe('hello');
    expect(parsed.foo).toBe(1);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts sensitive field names', () => {
    log.info('test.scope', 'leak test', {
      email: 'alice@example.com',
      password: 'hunter2',
      token: 'jwt-xxx',
      apiKey: 'sk-xxx',
      auth: 'Bearer xxx',
      cookie: 'sid=yyy',
      body: 'should not appear',
      prompt: 'also redaction',
      query: '?secret=z',
    });
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.email).toBe('[REDACTED]');
    expect(parsed.password).toBe('[REDACTED]');
    expect(parsed.token).toBe('[REDACTED]');
    expect(parsed.apiKey).toBe('[REDACTED]');
    expect(parsed.auth).toBe('[REDACTED]');
    expect(parsed.cookie).toBe('[REDACTED]');
    expect(parsed.body).toBe('[REDACTED]');
    expect(parsed.prompt).toBe('[REDACTED]');
    expect(parsed.query).toBe('[REDACTED]');
  });

  it('redacts nested sensitive fields', () => {
    log.info('test.scope', 'nested', { user: { password: 'x', nested: { apiKey: 'y' } } });
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.user.password).toBe('[REDACTED]');
    expect(parsed.user.nested.apiKey).toBe('[REDACTED]');
  });

  it('truncates very long string values', () => {
    const huge = 'x'.repeat(5000);
    log.info('test.scope', 'big', { description: huge });
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.description.length).toBeLessThan(5000);
    expect(parsed.description).toContain('[TRUNCATED]');
  });

  it('respects LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'warn';
    log.info('test.scope', 'should be skipped');
    log.warn('test.scope', 'should appear');
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]).level).toBe('warn');
    delete process.env.LOG_LEVEL;
  });
});

describe('withRequestId', () => {
  it('returns incoming x-request-id when valid', () => {
    const h = new Headers({ 'x-request-id': 'req-12345678' });
    expect(withRequestId(h)).toBe('req-12345678');
  });
  it('generates UUID when missing', () => {
    const h = new Headers();
    const id = withRequestId(h);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('generates UUID when invalid format', () => {
    const h = new Headers({ 'x-request-id': 'short' });
    expect(withRequestId(h).length).toBeGreaterThanOrEqual(36);
  });
});

describe('serializeError', () => {
  it('serializes Error with truncated stack', () => {
    const err = new Error('boom');
    err.stack = 'a'.repeat(2000);
    const out = serializeError(err);
    expect(out.message).toBe('boom');
    expect((out.stack as string).length).toBeLessThan(2000);
  });
  it('handles non-Error values', () => {
    expect(serializeError('oops')).toEqual({ value: 'oops' });
    expect(serializeError(null)).toEqual({ message: 'unknown' });
  });
});