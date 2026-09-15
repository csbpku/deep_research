import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { fetchAiEngine } from './fetch-ai-engine';

afterEach(() => vi.unstubAllGlobals());

describe('fetchAiEngine', () => {
  it('keeps FastAPI validation errors distinct from an unavailable engine', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: [{ loc: ['body', 'selection'], msg: 'Field required', type: 'missing' }],
    }), { status: 422 })));

    const result = await fetchAiEngine({ url: 'http://ai.test/assistant', requestId: 'req-1', context: 'test' });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'Field required',
      details: [{ location: ['body', 'selection'], message: 'Field required', type: 'missing' }],
    }));
  });

  it('retries a 5xx and preserves unavailable semantics', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('upstream down', { status: 503 }))
      .mockResolvedValueOnce(new Response('upstream down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAiEngine({ url: 'http://ai.test/assistant', requestId: 'req-2', context: 'test' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual(expect.objectContaining({ ok: false, code: ERROR_CODES.AI_ENGINE_UNAVAILABLE }));
  });

  it('does not retry an expensive request after the client disconnects', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('http://ai.test/assistant');
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAiEngine({
      url: 'http://ai.test/assistant',
      requestId: 'req-3',
      context: 'test',
      retry: true,
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ ok: false, code: ERROR_CODES.AI_ENGINE_UNAVAILABLE }));
  });
});
