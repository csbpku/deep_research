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

import { POST } from '../answer-image/route';

const userId = '11111111-1111-4111-8111-111111111111';
const imageDataUrl = 'data:image/png;base64,iVBORw0KGgo=';

function request(body: unknown): Request {
  return new Request('http://localhost/api/reading/answer-image', {
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
    body: { suggestion: '{"answer":"A system diagram."}', finishReason: 'stop', metrics: { model: 'vision-test' } },
  });
});

describe('POST /api/reading/answer-image', () => {
  it('passes only authenticated browser-supplied image bytes to the engine', async () => {
    const response = await POST(request({
      imageDataUrl,
      alt: 'A system diagram',
      title: 'Architecture',
      language: 'zh-CN',
      prompt: 'What does the diagram show?',
      body: 'A system diagram.',
      history: [{ role: 'user', content: 'Explain its components.' }],
    }) as never);

    expect(response.status).toBe(200);
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://ai.test/api/ai/reading/answer-image',
      body: expect.objectContaining({
        requester_id: userId,
        image_media_type: 'image/png',
        image_base64: 'iVBORw0KGgo=',
        image_alt: 'A system diagram',
        prompt: 'What does the diagram show?',
        history: [{ role: 'user', content: 'Explain its components.' }],
      }),
    }));
    expect(await response.json()).toMatchObject({
      suggestion: '{"answer":"A system diagram."}', truncated: false,
    });
  });
  it('does not call the model for anonymous requests', async () => {
    mocks.requireReadingUser.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    const response = await POST(request({ imageDataUrl, prompt: 'Explain' }) as never);
    expect(response.status).toBe(401);
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
  });

  it('rejects image URLs and unbounded article context', async () => {
    await expect(POST(request({ imageDataUrl: 'https://private.test/image.png', prompt: 'Explain' }) as never)).rejects.toThrow();
    await expect(POST(request({ imageDataUrl, prompt: 'Explain', body: 'x'.repeat(24001) }) as never)).rejects.toThrow();
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
  });

});
