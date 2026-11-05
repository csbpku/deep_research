import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), findMany: vi.fn(), create: vi.fn(), audit: vi.fn(), lock: vi.fn(), tx: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({ requireAdmin: mocks.auth }));
vi.mock('@/lib/db', () => ({ prisma: { radarSource: { findMany: mocks.findMany }, $transaction: mocks.tx } }));
import { GET, POST } from './route';
import { feedIdentity } from '@/lib/radar/source-presets';

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/radar/source-presets', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }) as never;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001' });
  mocks.findMany.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000002', name: 'Simon Willison 的博客' });
  mocks.audit.mockResolvedValue({});
  mocks.tx.mockImplementation(async (fn) => fn({ $executeRaw: mocks.lock, radarSource: { findMany: mocks.findMany, create: mocks.create }, adminAction: { create: mocks.audit } }));
});
describe('source presets', () => {
  it('rejects non-admin on reads and writes before database access', async () => {
    mocks.auth.mockResolvedValue(NextResponse.json({ code: 'FORBIDDEN' }, { status: 403 }));
    expect((await GET(new Request('http://localhost/api/admin/radar/source-presets') as never)).status).toBe(403);
    expect((await POST(request({ presetId: 'simon-willison-entries' }))).status).toBe(403);
    expect(mocks.findMany).not.toHaveBeenCalled(); expect(mocks.tx).not.toHaveBeenCalled();
  });
  it('rejects unknown ids and arbitrary URLs and cross-origin mutations', async () => {
    expect((await POST(request({ presetId: 'evil' }))).status).toBe(400);
    expect((await POST(request({ presetId: 'simon-willison-entries', feedUrl: 'http://127.0.0.1/' }))).status).toBe(400);
    expect((await POST(request({ presetId: 'simon-willison-entries' }, { origin: 'https://evil.example', host: 'localhost' }))).status).toBe(403);
    expect(mocks.tx).not.toHaveBeenCalled();
  });
  it('normalizes ordinary URL spelling variants and preserves meaningful query', () => {
    expect(feedIdentity(' HTTP://WWW.SIMONWILLISON.NET:80/atom/entries/#foo ')).toBe(feedIdentity('https://simonwillison.net/atom/entries'));
    expect(feedIdentity('https://example.com/rss?b=2&a=1')).toBe(feedIdentity('https://example.com/rss?a=1&b=2'));
    expect(feedIdentity('https://example.com/rss?a=1')).not.toBe(feedIdentity('https://example.com/rss?a=2'));
  });
  it('creates the fixed RSS config and audit record only after taking a table lock', async () => {
    const response = await POST(request({ presetId: 'simon-willison-entries' }));
    expect(response.status).toBe(201);
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.findMany.mock.invocationCallOrder[0]!);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sourceType: 'rss', enabled: true, config: expect.objectContaining({ feedUrl: 'https://simonwillison.net/atom/entries/' }) }) }));
    expect(mocks.audit).toHaveBeenCalledOnce();
  });
  it('reports existing disabled source without changing it, even with a different ID', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'existing', name: 'Manual', enabled: false, autoPausedAt: null, config: { feedUrl: 'HTTP://WWW.SIMONWILLISON.NET/atom/entries' } }]);
    const response = await POST(request({ presetId: 'simon-willison-entries' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ created: false, existing: [{ id: 'existing', name: 'Manual', enabled: false, autoPaused: false }] });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
});
