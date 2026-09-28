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

import { POST } from '../translate-image/route';

const userId = '11111111-1111-4111-8111-111111111111';
const imageDataUrl = 'data:image/png;base64,iVBORw0KGgo=';

function request(body: unknown): Request {
  return new Request('http://localhost/api/reading/translate-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireReadingUser.mockResolvedValue({ id: userId });
  mocks.fetchAiEngine.mockResolvedValue({
    ok: true,
    body: { suggestion: '{"regions":[]}', finishReason: 'stop', metrics: { model: 'vision-test' } },
  });
});

describe('POST /api/reading/translate-image', () => {
  it('passes only authenticated browser-supplied image bytes to the engine', async () => {
    const response = await POST(request({
      imageDataUrl,
      alt: 'A system diagram',
      title: 'Architecture',
      language: 'zh-CN',
      retry: true,
    }) as never);

    expect(response.status).toBe(200);
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://ai.test/api/ai/reading/translate-image',
      body: expect.objectContaining({
        requester_id: userId,
        image_media_type: 'image/png',
        image_base64: 'iVBORw0KGgo=',
        image_alt: 'A system diagram',
        retry: true,
      }),
    }));
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: '{"regions":[]}' }, finish_reason: 'stop' }],
    });
  });
});
