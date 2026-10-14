import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { $queryRaw: mocks.queryRaw } }));

import { GET } from '../readyz/route';

describe('GET /api/readyz', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.useRealTimers());

  it('returns 200 when the database answers', async () => {
    mocks.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 503 without detail when the query fails', async () => {
    mocks.queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  it('returns 503 when the query hangs past the timeout', async () => {
    vi.useFakeTimers();
    mocks.queryRaw.mockReturnValue(new Promise(() => {}));
    const pending = GET();
    await vi.advanceTimersByTimeAsync(2100);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });
});
