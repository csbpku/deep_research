// 启动前预检 BFF：引擎结果透传 + 不可达时仍返回可展示的失败原因。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const MOCK_USER = { id: '11111111-1111-4111-8111-111111111111', role: 'member' as const };

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  fetchAiEngine: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/env', () => ({ getWebEnv: () => ({ AI_ENGINE_URL: 'http://ai.test/' }) }));
vi.mock('@/lib/ai-bff/fetch-ai-engine', () => ({ fetchAiEngine: mocks.fetchAiEngine }));

import { NextResponse } from 'next/server';
import { GET } from '../preflight/route';

function request(): Request {
  return new Request('http://localhost/api/ai-research/preflight');
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(MOCK_USER);
  mocks.fetchAiEngine.mockResolvedValue({
    ok: true,
    status: 200,
    body: {
      ok: true,
      checks: [
        { name: 'adapter', ok: true, message: '适配器已就绪：gpt_researcher' },
        { name: 'research_llm', ok: true, message: 'RESEARCH_LLM 槽位可用：minimax:MiniMax-M3.1-Flash' },
        { name: 'model_probe', ok: true, message: '模型连通性正常' },
      ],
      checkedAt: '2026-11-11T00:00:00+00:00',
    },
  });
});

describe('GET /api/ai-research/preflight', () => {
  it('proxies the engine preflight without retrying or long waits', async () => {
    const res = await GET(request() as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks).toHaveLength(3);
    expect(body.checkedAt).toBe('2026-11-11T00:00:00+00:00');
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://ai.test/health/preflight',
      context: 'ai.bff.preflight',
      timeoutMs: 6000,
      retry: false,
    }));
  });

  it('bypasses the engine cache when the user asks to re-check', async () => {
    const res = await GET(new Request(
      'http://localhost/api/ai-research/preflight?refresh=1',
    ) as never);

    expect(res.status).toBe(200);
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://ai.test/health/preflight?force=true',
    }));
  });

  it('returns ok:false with a clear message when the engine is unreachable', async () => {
    mocks.fetchAiEngine.mockResolvedValue({
      ok: false,
      code: 'AI_ENGINE_UNAVAILABLE',
      requestId: 'req-1',
      message: 'AI 调研服务暂时不可用，请稍后重试',
    });

    const res = await GET(request() as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks).toEqual([{
      name: 'ai_engine',
      ok: false,
      message: 'AI 调研服务暂时不可用，请确认 AI engine 已启动后重试。',
    }]);
  });

  it('keeps failed checks and warning levels from the engine', async () => {
    mocks.fetchAiEngine.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        ok: false,
        checks: [
          { name: 'research_llm', ok: false, message: '缺少 MINIMAX_API_KEY' },
          { name: 'model_probe', ok: true, level: 'warning', message: '探测超时' },
        ],
        checkedAt: '2026-11-11T00:00:00+00:00',
      },
    });

    const res = await GET(request() as never);
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.checks[0]).toMatchObject({ name: 'research_llm', ok: false });
    expect(body.checks[1]).toMatchObject({ name: 'model_probe', level: 'warning' });
  });

  it('passes through the unauthenticated response', async () => {
    mocks.requireUser.mockResolvedValue(
      new NextResponse(JSON.stringify({ code: 'AUTH_NOT_AUTHENTICATED' }), { status: 401 }),
    );

    const res = await GET(request() as never);

    expect(res.status).toBe(401);
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
  });
});
