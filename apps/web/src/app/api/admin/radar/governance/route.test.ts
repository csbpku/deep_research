import { beforeEach, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/env', () => ({ getWebEnv: () => ({ AI_ENGINE_URL: 'http://engine', INTERNAL_SERVICE_TOKEN: 'test-token' }) }));
import { POST } from './route';

const actor = '00000000-0000-4000-8000-000000000001';
function request(body: unknown) {
  return new Request('http://localhost/api/admin/radar/governance', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.requireAdmin.mockResolvedValue({ id: actor, role: 'admin' });
  mocks.fetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
});

it.each([401, 403])('blocks unauthenticated/non-admin requests (%s)', async (status) => {
  mocks.requireAdmin.mockResolvedValue(NextResponse.json({}, { status }));
  expect((await POST(request({ mode: 'preview' }) as never)).status).toBe(status);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it.each([{ mode: 'preview', actorId: actor }, { mode: 'apply' }, { mode: 'preview', limit: 101 }])(
  'rejects spoofing and invalid bounds: %j', async (body) => {
    expect((await POST(request(body) as never)).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  },
);

it('forwards only the authenticated Admin identity', async () => {
  expect((await POST(request({ mode: 'preview' }) as never)).status).toBe(200);
  const [url, options] = mocks.fetch.mock.calls[0]!;
  expect(url).toBe('http://engine/api/radar/governance');
  expect(JSON.parse(options.body)).toEqual({ mode: 'preview', limit: 10, actorId: actor });
});
