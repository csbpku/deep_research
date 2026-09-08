import { describe, expect, it, vi } from 'vitest';

import { tryStreamChat } from './useChatSession';

function mockSseResponse(chunks: string[]): Response {
  let index = 0;
  const reader = {
    read: vi.fn(async () => {
      if (index >= chunks.length) return { value: undefined, done: true };
      const value = new TextEncoder().encode(chunks[index]);
      index += 1;
      return { value, done: false };
    }),
    cancel: vi.fn(async () => undefined),
  };
  return {
    ok: true,
    body: { getReader: () => reader },
    headers: { get: () => 'text/event-stream; charset=utf-8' },
  } as unknown as Response;
}

const callbacks = () => ({
  onDelta: vi.fn(),
  onCitations: vi.fn(),
  onDone: vi.fn(),
});

describe('tryStreamChat', () => {
  it('does not treat a stream that ends without done as successful', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockSseResponse(['event: delta\ndata: "partial"\n\n']),
    ));
    const handlers = callbacks();

    const outcome = await tryStreamChat('session-1', 'question', null, 'full', handlers);

    expect(outcome).toBe('error');
    expect(handlers.onDelta).toHaveBeenCalledWith('partial');
    expect(handlers.onDone).not.toHaveBeenCalled();
  });

  it('accepts a final done frame even when the server omits the trailing blank line', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockSseResponse([
        'event: done\ndata: {"message_id":"message-1","content":"回答","created_at":"2026-09-02T00:00:00.000Z"}',
      ]),
    ));
    const handlers = callbacks();

    const outcome = await tryStreamChat('session-1', 'question', null, 'full', handlers);

    expect(outcome).toBe('streamed');
    expect(handlers.onDone).toHaveBeenCalledWith({
      id: 'message-1',
      content: '回答',
      createdAt: '2026-09-02T00:00:00.000Z',
      latencyMs: null,
      sources: null,
    });
  });
});
