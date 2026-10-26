import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  jobCreate: vi.fn(),
  jobUpdateMany: vi.fn(),
  recordProductEvent: vi.fn(),
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
vi.mock('@/lib/product-events', () => ({ recordProductEvent: mocks.recordProductEvent }));
vi.mock('@/lib/ai-bff/fetch-ai-engine', () => ({ aiEngineServiceAuthHeaders: () => ({}) }));

import { POST } from '../route';

function request(body: Record<string, unknown> = { topic: 'quota check', reportLength: 'deep' }) {
  return new Request('http://localhost/api/ai-research', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'member' });
  mocks.jobCreate.mockResolvedValue({ id: JOB_ID });
  mocks.jobUpdateMany.mockResolvedValue({ count: 1 });
  mocks.recordProductEvent.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/ai-research when the engine does not accept the job', () => {
  it('checkpoints complete legacy input outside the varchar display fields', async () => {
    const question = 'Grok Bot '.repeat(500);
    const context = 'Requirements '.repeat(1000) + 'FINAL REQUIREMENT';
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job_id: JOB_ID, status: 'queued' }), { status: 202 }));
    vi.stubGlobal('fetch', upstream);
    await POST(request({ topic: question, context }));
    const { data } = mocks.jobCreate.mock.calls[0][0];
    expect(data.topic).toHaveLength(200);
    expect(data.context).toHaveLength(2000);
    expect(data.brief.question).toBe(question);
    expect(data.brief.context).toBe(context);
    expect(data.brief._engineContext).toContain('FINAL REQUIREMENT');
    const payload = JSON.parse(upstream.mock.calls[0][1].body);
    expect(payload.context).toContain(question.trim());
    expect(payload.context).toContain('FINAL REQUIREMENT');
  });

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
