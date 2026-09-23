import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireReadingUser: vi.fn(),
  fetchAiEngine: vi.fn(),
}));

vi.mock('../../../../lib/api-handler', () => ({
  apiHandler: (handler: unknown) => handler,
  parseBody: async (req: Request, schema: { parse: (value: unknown) => unknown }) => schema.parse(await req.json()),
}));
vi.mock('../../../../lib/reading-auth', () => ({ requireReadingUser: mocks.requireReadingUser }));
vi.mock('../../../../lib/ai-bff/fetch-ai-engine', () => ({ fetchAiEngine: mocks.fetchAiEngine }));
vi.mock('../../../../lib/env', () => ({ getWebEnv: () => ({ AI_ENGINE_URL: 'http://ai.test' }) }));

import { POST } from '../translate/route';

function request(blocks: Array<{ id: string; text: string }>): Request {
  return new Request('http://localhost/api/reading/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/docs', title: 'Docs', language: 'zh-CN', blocks }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireReadingUser.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' });
  mocks.fetchAiEngine.mockResolvedValue({ ok: true, body: { suggestion: '翻译后的段落' } });
});

describe('POST /api/reading/translate', () => {
  it('reuses a translation for an identical text fingerprint', async () => {
    const text = 'This paragraph explains the bounded reading context.';
    const first = await POST(request([{ id: 'block-a', text }]) as never);
    const second = await POST(request([{ id: 'block-b', text }]) as never);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.fetchAiEngine).toHaveBeenCalledTimes(1);
    expect((await second.json()).translations).toEqual([{
      id: 'block-b',
      text: '翻译后的段落',
      sourceText: text,
    }]);
  });
});
