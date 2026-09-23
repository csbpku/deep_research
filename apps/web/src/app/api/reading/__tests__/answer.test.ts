import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'reader@example.com', role: 'member' as const };
const mocks = vi.hoisted(() => ({
  requireReadingUser: vi.fn(),
  fetchAiEngine: vi.fn(),
}));

vi.mock('@/lib/api-handler', () => ({
  apiHandler: (handler: unknown) => handler,
  parseBody: async (req: Request, schema: { parse: (value: unknown) => unknown }) => schema.parse(await req.json()),
}));
vi.mock('../../../../lib/api-handler', () => ({
  apiHandler: (handler: unknown) => handler,
  parseBody: async (req: Request, schema: { parse: (value: unknown) => unknown }) => schema.parse(await req.json()),
}));
vi.mock('@/lib/reading-auth', () => ({ requireReadingUser: mocks.requireReadingUser }));
vi.mock('../../../../lib/reading-auth', () => ({ requireReadingUser: mocks.requireReadingUser }));
vi.mock('@/lib/ai-bff/fetch-ai-engine', () => ({ fetchAiEngine: mocks.fetchAiEngine }));
vi.mock('../../../../lib/ai-bff/fetch-ai-engine', () => ({ fetchAiEngine: mocks.fetchAiEngine }));
vi.mock('@/lib/env', () => ({ getWebEnv: () => ({ AI_ENGINE_URL: 'http://ai.test' }) }));
vi.mock('../../../../lib/env', () => ({ getWebEnv: () => ({ AI_ENGINE_URL: 'http://ai.test' }) }));

import { POST } from '../answer/route';

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

function request(input: unknown) {
  return new Request('http://localhost/api/reading/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }) as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireReadingUser.mockResolvedValue(USER);
  mocks.fetchAiEngine.mockResolvedValue({ ok: true, body: { original: quote, suggestion: '回答' } });
});

describe('POST /api/reading/answer', () => {
  it('keeps focused questions within the selected section', async () => {
    const response = await POST(request({
      action: 'ask',
      prompt: '为什么？',
      context: { url: 'https://example.com/docs', title: 'Docs', body, section: '当前小节\n\n' + body, selection: anchor, scope: 'selection' },
    }));
    expect(response.status).toBe(200);
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ body: '当前小节\n\n' + body, selection: expect.objectContaining({ quote }) }),
    }));
  });

  it('rejects a stale anchor before contacting the model', async () => {
    const response = await POST(request({
      action: 'explain',
      context: { url: 'https://example.com/docs', title: 'Docs', body: body + ' changed', selection: anchor, scope: 'selection' },
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain('已变化');
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
  });

  it('does not attach the selection as model original when the user asks the whole page', async () => {
    const response = await POST(request({
      action: 'ask',
      prompt: '这页的结论是什么？',
      context: { url: 'https://example.com/docs', title: 'Docs', body, selection: anchor, scope: 'page' },
    }));
    expect(response.status).toBe(200);
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ body, selection: undefined }),
    }));
  });
});
