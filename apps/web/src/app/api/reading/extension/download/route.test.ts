import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWebEnv: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('../../../../../lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('../../../../../lib/env', () => ({ getWebEnv: mocks.getWebEnv }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));

import { GET } from './route';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'reader@example.com',
  role: 'member' as const,
};
const ENV = {
  READING_EXTENSION_BETA_URL: '',
  READING_EXTENSION_BETA_PATH: '/artifacts/deep-research-reader-beta-0.2.2.zip',
  READING_EXTENSION_BETA_VERSION: '0.2.2',
  READING_EXTENSION_BETA_SHA256: 'a'.repeat(64),
};

function request(): Request {
  return new Request('http://localhost/api/reading/extension/download');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
  mocks.getWebEnv.mockReturnValue(ENV);
  mocks.readFile.mockResolvedValue(Buffer.from('PK\x03\x04beta'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/reading/extension/download', () => {
  it('requires a signed-in user before touching the artifact', async () => {
    mocks.requireUser.mockResolvedValue(
      NextResponse.json({ ok: false, code: 'AUTH_NOT_AUTHENTICATED' }, { status: 401 }),
    );

    const response = await GET(request() as never);

    expect(response.status).toBe(401);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('serves the configured mounted Beta ZIP with download headers', async () => {
    const response = await GET(request() as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="deep-research-reader-beta-0.2.2.zip"',
    );
    expect(response.headers.get('x-content-sha256')).toBe('a'.repeat(64));
    expect(response.headers.get('cache-control')).toContain('private');
    expect(Buffer.from(await response.arrayBuffer()).toString('latin1')).toBe('PK\x03\x04beta');
  });

  it('proxies a configured release URL when no mounted path is available', async () => {
    mocks.getWebEnv.mockReturnValue({
      ...ENV,
      READING_EXTENSION_BETA_PATH: '',
      READING_EXTENSION_BETA_URL: 'https://downloads.example.test/reader.zip',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('release-zip', {
      status: 200,
      headers: { 'content-length': '11' },
    }));

    const response = await GET(request() as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('11');
    expect(await response.text()).toBe('release-zip');
  });

  it('returns an explicit unavailable response when no artifact is configured', async () => {
    mocks.getWebEnv.mockReturnValue({
      ...ENV,
      READING_EXTENSION_BETA_PATH: '',
      READING_EXTENSION_BETA_URL: '',
    });

    const response = await GET(request() as never);

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('READING_EXTENSION_BETA_UNAVAILABLE');
  });
});
