import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import setup from '../../e2e/mui-isolated-setup';

const fetchFixture = vi.fn();
beforeEach(() => {
  vi.stubEnv('MUI_ISOLATED_BROWSER', '1');
  vi.stubEnv('E2E_BASE_URL', 'http://127.0.0.1:3122');
  vi.stubGlobal('fetch', fetchFixture);
  fetchFixture.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('isolated MUI browser preflight fails closed', () => {
  it.each(['', '0'])('requires explicit opt-in (%s)', async optIn => {
    vi.stubEnv('MUI_ISOLATED_BROWSER', optIn);
    await expect(setup()).rejects.toThrow('explicitly selected isolated MUI server');
    expect(fetchFixture).not.toHaveBeenCalled();
  });

  it.each(['http://127.0.0.1:3000', 'https://example.com:3122'])('refuses the ordinary or external service (%s)', async origin => {
    vi.stubEnv('E2E_BASE_URL', origin);
    await expect(setup()).rejects.toThrow('ordinary development service');
    expect(fetchFixture).not.toHaveBeenCalled();
  });

  it('propagates an unavailable listener without starting a replacement or authenticating', async () => {
    fetchFixture.mockRejectedValue(new TypeError('fetch failed'));
    await expect(setup()).rejects.toThrow('fetch failed');
    expect(fetchFixture).toHaveBeenCalledTimes(1);
    expect(fetchFixture).toHaveBeenCalledWith('http://127.0.0.1:3122/api/topics?limit=80', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('rejects HTTP failures before reading content', async () => {
    const json = vi.fn();
    fetchFixture.mockResolvedValue({ ok: false, status: 503, json });
    await expect(setup()).rejects.toThrow('HTTP 503');
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    { total: 0, items: [] },
    { total: 6, items: Array.from({ length: 6 }, () => ({ slug: 'ordinary-topic' })) },
    { total: 7, items: Array.from({ length: 6 }, (_, i) => ({ slug: `mui-topic-${i + 1}` })) },
  ])('rejects a live but non-fixture service (%j)', async data => {
    fetchFixture.mockResolvedValue({ ok: true, json: async () => data });
    await expect(setup()).rejects.toThrow('Not the dedicated MUI fixture service');
    expect(fetchFixture).toHaveBeenCalledTimes(1);
  });

  it('accepts only the complete six-topic fixture identity regardless of ordering', async () => {
    fetchFixture.mockResolvedValue({ ok: true, json: async () => ({
      total: 6, items: Array.from({ length: 6 }, (_, i) => ({ slug: `mui-topic-${6 - i}` })),
    }) });
    await expect(setup()).resolves.toBeUndefined();
    expect(fetchFixture).toHaveBeenCalledTimes(1);
  });
});
