import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchChatEngine, streamChatEngine } from './chat-bff';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('chat BFF internal authentication', () => {
  it('adds the internal token to both ordinary and streaming engine requests', async () => {
    vi.stubEnv('INTERNAL_SERVICE_TOKEN', 'reader-test-service-token');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchChatEngine('http://ai.test/chat', { method: 'POST' }, 'req-chat', 1_000, 'test.chat');
    await streamChatEngine('http://ai.test/chat/stream', { method: 'POST' }, 'req-stream', 'test.chat.stream');

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-internal-token': 'reader-test-service-token',
      'x-request-id': 'req-chat',
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'x-internal-token': 'reader-test-service-token',
      'x-request-id': 'req-stream',
      accept: 'text/event-stream',
    });
  });
});
