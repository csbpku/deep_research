import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const ID = '11111111-1111-4111-8111-111111111111';
const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser, requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/db', () => ({
  prisma: {
    summary: { findUnique: mocks.findUnique, update: mocks.update, updateMany: mocks.updateMany },
    $executeRaw: mocks.executeRaw,
  },
}));
vi.mock('@/lib/env', () => ({ getWebEnv: () => ({ AI_ENGINE_URL: 'http://ai.test', INTERNAL_SERVICE_TOKEN: 't' }) }));
vi.mock('@/lib/radar/runtime-flags', () => ({
  radarEnrichmentEnabled: () => true,
  radarEnrichmentPauseReason: () => '',
}));

import { POST as refresh } from '../radar/[id]/refresh/route';
import { POST as migrate } from '../radar/[id]/migrate/route';

const req = () => new Request(`http://localhost/api/radar/${ID}/x`, { method: 'POST' }) as never;
const ctx = { params: Promise.resolve({ id: ID }) };
const unauth = () => NextResponse.json({ code: 'AUTH_NOT_AUTHENTICATED' }, { status: 401 });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn());
});

describe('POST /api/radar/[id]/refresh', () => {
  it('rejects anonymous / non-admin callers without touching the engine', async () => {
    mocks.requireAdmin.mockResolvedValue(unauth());
    const res = await refresh(req(), ctx);
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});

describe('POST /api/radar/[id]/migrate', () => {
  it('rejects anonymous callers', async () => {
    mocks.requireUser.mockResolvedValue(unauth());
    const res = await migrate(req(), ctx);
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('rolls back only the migration tag atomically when the enqueue fails', async () => {
    mocks.requireUser.mockResolvedValue({ id: 'u', role: 'member' });
    mocks.findUnique.mockResolvedValue({
      id: ID, source: 'daily', syncRunId: 'r', shareSource: null, tags: ['a'],
      distilledTier: null, distilledTargetTier: null, enrichmentStatus: null, readerQualityStatus: null,
      originalKind: 'rss', url: 'https://x.test/a', canonicalUrl: 'https://x.test/a',
      originalMarkdown: 'short', body: 'short', originalMeta: null, highlights: null,
    });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 500 }));
    const res = await migrate(req(), ctx);
    expect(res.status).toBe(503);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    // never writes back the stale tags snapshot
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
