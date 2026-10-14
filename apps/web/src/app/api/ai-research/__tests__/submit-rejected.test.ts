import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  jobCreate: vi.fn(),
  jobUpdateMany: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/db', () => ({
  prisma: { aiResearchJob: { create: mocks.jobCreate, updateMany: mocks.jobUpdateMany } },
}));
vi.mock('@/lib/env', () => ({ getWebEnv: () => ({ AI_ENGINE_URL: 'http://ai.test' }) }));
vi.mock('@/lib/product-events', () => ({ recordProductEvent: vi.fn() }));
vi.mock('@/lib/ai-bff/fetch-ai-engine', () => ({ aiEngineServiceAuthHeaders: () => ({}) }));

import { POST } from '../route';

function request() {
  return new Request('http://localhost/api/ai-research', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'quota check', reportLength: 'deep' }),
  }) as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'member' });
  mocks.jobCreate.mockResolvedValue({ id: JOB_ID });
  mocks.jobUpdateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/ai-research when the engine does not accept the job', () => {
  it('marks the pre-created row failed so the DB worker cannot run it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'AI_QUOTA_EXCEEDED', message: '个人今日 AI 调研配额已用完' }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    )));
    const res = await POST(request());
    expect(res.status).toBe(429);
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: { id: JOB_ID, status: 'queued' },
      data: expect.objectContaining({ status: 'failed', errorCode: 'AI_QUOTA_EXCEEDED' }),
    });
  });

  it('fails the row when the engine is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await POST(request());
    expect(mocks.jobUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('leaves the row alone on a timeout, where the engine may have accepted it', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await POST(request());
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
  });
});
