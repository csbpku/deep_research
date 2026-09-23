import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'reader@example.com', role: 'member' as const };
const mocks = vi.hoisted(() => ({ requireReadingUser: vi.fn() }));

vi.mock('../../../../lib/api-handler', () => ({
  apiHandler: (handler: unknown) => handler,
  parseBody: async (req: Request, schema: { parse: (value: unknown) => unknown }) => schema.parse(await req.json()),
}));
vi.mock('../../../../lib/reading-auth', () => ({ requireReadingUser: mocks.requireReadingUser }));
vi.mock('../../../../lib/env', () => ({ getWebEnv: () => ({ AI_ENGINE_URL: 'http://ai.test' }) }));

import { POST } from '../answer/stream/route';

const body = 'A focused section explains why bounded context matters.\n\nA second paragraph adds the operational limit.';
const quote = 'A focused section explains why bounded context matters.';
const startOffset = body.indexOf(quote);
const anchor = {
  quote,
  prefix: '',
  suffix: '',
  startOffset,
  endOffset: startOffset + quote.length,
  contentHash: createHash('sha256').update(body).digest('hex'),
};

function request(input: unknown): Request {
  return new Request('http://localhost/api/reading/answer/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.requireReadingUser.mockResolvedValue(USER);
});

describe('POST /api/reading/answer/stream', () => {
  it('forwards the provider SSE without buffering it in the BFF', async () => {
    const upstream = [
      'event: meta\ndata: {"operation":"ask","streaming":true}\n\n',
      'event: delta\ndata: {"text":"答案"}\n\n',
      'event: done\ndata: {"suggestion":"答案"}\n\n',
    ].join('');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(upstream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const response = await POST(request({
      action: 'ask',
      prompt: '为什么？',
      context: { url: 'https://example.com/docs', title: 'Docs', body, section: body, selection: anchor, scope: 'selection' },
    }) as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const streamText = await response.text();
    expect(streamText).toContain('event: delta');
    expect(streamText).toContain('"citations"');
    expect(fetchMock).toHaveBeenCalledWith('http://ai.test/api/ai/research-assistant/stream', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"operation":"ask"'),
    }));
  });

  it('rejects a stale anchor before opening the provider stream', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = await POST(request({
      action: 'explain',
      context: { url: 'https://example.com/docs', title: 'Docs', body: body + ' changed', selection: anchor, scope: 'selection' },
    }) as never);

    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain('已变化');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
