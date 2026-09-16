import { describe, expect, it } from 'vitest';
import { parseWebEnv, emailDomain } from './env';

const validBase = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  NEXTAUTH_SECRET: 'a-very-long-secret-1234567890',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  AUTH_GOOGLE_ONLY: '0',
  ALLOWED_EMAIL_DOMAINS: 'example.com,foo.org',
};

describe('parseWebEnv', () => {
  it('accepts a minimal valid env', () => {
    const env = parseWebEnv({ ...validBase, NODE_ENV: 'development' });
    expect(env.NEXTAUTH_URL).toBe('http://localhost:3000');
    expect(env.AI_ENGINE_URL).toBe('http://localhost:4000');
    expect(env.MAX_UPLOAD_SIZE_MB).toBe(5);
    expect(env.TIME_VALUE_USD_PER_HOUR).toBe(50);
    expect(env.ALLOWED_EMAIL_DOMAINS).toEqual(['example.com', 'foo.org']);
    expect(env.AUTH_GOOGLE_ONLY).toBe(false);
    expect(env.AUTH_INVITE_CODE).toBe('');
    expect(env.AUTH_ALLOW_INSECURE_HTTP).toBe(false);
    expect(env.BOOTSTRAP_ADMIN_EMAIL).toBe('shaobo.chen@shopee.com');
  });

  it('accepts missing Google OAuth credentials (local UI mode)', () => {
    const { GOOGLE_CLIENT_ID: _id, GOOGLE_CLIENT_SECRET: _secret, ...rest } = validBase;
    const env = parseWebEnv({ ...rest, NODE_ENV: 'development' });
    expect(env.GOOGLE_CLIENT_ID).toBe('');
    expect(env.GOOGLE_CLIENT_SECRET).toBe('');
  });

  it('rejects empty ALLOWED_EMAIL_DOMAINS outside Google-only mode', () => {
    expect(() =>
      parseWebEnv({ ...validBase, ALLOWED_EMAIL_DOMAINS: '  ,  ,  ', NODE_ENV: 'development' }),
    ).toThrow(/ALLOWED_EMAIL_DOMAINS/);
  });

  it('accepts Google-only mode without ALLOWED_EMAIL_DOMAINS', () => {
    const { ALLOWED_EMAIL_DOMAINS: _domains, ...rest } = validBase;
    const env = parseWebEnv({
      ...rest,
      AUTH_GOOGLE_ONLY: '1',
      NODE_ENV: 'production',
    });
    expect(env.AUTH_GOOGLE_ONLY).toBe(true);
    expect(env.ALLOWED_EMAIL_DOMAINS).toEqual([]);
  });

  it('requires Google credentials in Google-only mode', () => {
    expect(() =>
      parseWebEnv({
        ...validBase,
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        AUTH_GOOGLE_ONLY: '1',
        NODE_ENV: 'production',
      }),
    ).toThrow(/Google OAuth credentials/);
  });

  it('rejects DATABASE_URL that is not postgres://', () => {
    expect(() =>
      parseWebEnv({ ...validBase, DATABASE_URL: 'mysql://localhost', NODE_ENV: 'development' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('accepts unknown keys (passthrough for Next.js-injected env)', () => {
    // production build 时 Next.js 注入大量内部 env keys；.passthrough() 放行未知 key
    // 避免 build 失败。真机环境中 ai-engine secret 不会出现在 web 进程 env。
    const env = parseWebEnv({ ...validBase, TAVILY_API_KEY: 'test-only', NODE_ENV: 'development' });
    expect(env).toBeDefined();
  });

  it('coerces numeric strings', () => {
    const env = parseWebEnv({
      ...validBase,
      MAX_UPLOAD_SIZE_MB: '10',
      TIME_VALUE_USD_PER_HOUR: '75.5',
      NODE_ENV: 'development',
    });
    expect(env.MAX_UPLOAD_SIZE_MB).toBe(10);
    expect(env.TIME_VALUE_USD_PER_HOUR).toBe(75.5);
  });

  it('rejects non-positive numeric', () => {
    expect(() =>
      parseWebEnv({ ...validBase, MAX_UPLOAD_SIZE_MB: '0', NODE_ENV: 'development' }),
    ).toThrow();
    expect(() =>
      parseWebEnv({ ...validBase, TIME_VALUE_USD_PER_HOUR: '-1', NODE_ENV: 'development' }),
    ).toThrow();
  });
});

describe('emailDomain', () => {
  it('extracts lowercase domain', () => {
    expect(emailDomain('Alice@Example.COM')).toBe('example.com');
  });
  it('returns empty for invalid email', () => {
    expect(emailDomain('no-at-sign')).toBe('');
    expect(emailDomain('trailing@')).toBe('');
  });
});
