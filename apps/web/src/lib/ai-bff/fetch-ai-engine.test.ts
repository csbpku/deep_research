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
      message: 'AI 请求参数不合法，请重新选择文本后重试',
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
});
