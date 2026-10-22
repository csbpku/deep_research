import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ requireReadingUser: vi.fn(), fetchAiEngine: vi.fn() }));
vi.mock('../../../../lib/api-handler', () => ({ apiHandler: (handler: unknown) => handler, parseBody: async (req: Request, schema: { parse: (x: unknown) => unknown }) => schema.parse(await req.json()) }));
vi.mock('../../../../lib/reading-auth', () => ({ requireReadingUser: mocks.requireReadingUser }));
vi.mock('../../../../lib/ai-bff/fetch-ai-engine', () => ({ fetchAiEngine: mocks.fetchAiEngine }));
vi.mock('../../../../lib/env', () => ({ getWebEnv: () => ({ AI_ENGINE_URL: 'http://ai.test' }) }));
import { POST } from '../search/route';
const request = () => new Request('http://localhost/api/reading/search', { method: 'POST', body: JSON.stringify({ question: 'Latest release?', title: 'Library' }) });
beforeEach(() => { vi.clearAllMocks(); mocks.requireReadingUser.mockResolvedValue({ id: 'test-user' }); mocks.fetchAiEngine.mockResolvedValue({ ok: true, body: { status: 'skipped', sources: [] } }); });
describe('Reading web search', () => {
  it('requires authentication before any model or search request', async () => {
    mocks.requireReadingUser.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    expect((await POST(request() as never)).status).toBe(401);
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
  });
  it('forwards only the bounded question/title and authenticated user id', async () => {
    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({ retry: false, body: { question: 'Latest release?', title: 'Library', requester_id: 'test-user' } }));
  });
});
