import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  summaryFindUnique: vi.fn(),
  summaryUpdate: vi.fn(),
  fetchAiEngine: vi.fn(),
  getWebEnv: vi.fn(),
}));

vi.mock('../../../lib/auth/session.js', () => ({
  getCurrentUser: mocks.getCurrentUser,
}));

vi.mock('../../../lib/db.js', () => ({
  prisma: {
    summary: {
      findUnique: mocks.summaryFindUnique,
      update: mocks.summaryUpdate,
    },
  },
}));

vi.mock('../../../lib/ai-bff/fetch-ai-engine.js', () => ({
  fetchAiEngine: mocks.fetchAiEngine,
}));

vi.mock('../../../lib/env.js', () => ({
  getWebEnv: mocks.getWebEnv,
}));

import { POST } from '../radar/[id]/transform/route';

const SUMMARY_ID = '11111111-1111-4111-8111-111111111111';

function request(mode: 'translate' | 'ai_reading' = 'translate') {
  return new Request(`http://localhost/api/radar/${SUMMARY_ID}/transform`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, language: 'zh-CN' }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentUser.mockResolvedValue(null);
  mocks.getWebEnv.mockReturnValue({
    AI_ENGINE_URL: 'http://ai.test',
    INTERNAL_SERVICE_TOKEN: 'internal',
  });
  mocks.summaryFindUnique.mockResolvedValue({
    id: SUMMARY_ID,
    title: '公开雷达',
    body: '摘要',
    originalMarkdown: '# Original\n\nLong source content.',
    originalMeta: null,
    source: 'daily',
    syncRunId: 'run-1',
    shareSource: null,
  });
  mocks.summaryUpdate.mockImplementation(async ({ data }: { data: { originalMeta: unknown } }) => {
    mocks.summaryFindUnique.mockResolvedValueOnce({
      id: SUMMARY_ID,
      title: '公开雷达',
      body: '摘要',
      originalMarkdown: '# Original\n\nLong source content.',
      originalMeta: data.originalMeta,
      source: 'daily',
      syncRunId: 'run-1',
      shareSource: null,
    });
    return {};
  });
  mocks.fetchAiEngine.mockResolvedValue({
    ok: true,
    status: 200,
    body: { suggestion: '# Translated\n\nTranslated content.' },
  });
});

describe('POST /api/radar/[id]/transform', () => {
  it('allows anonymous transforms and persists a source-hash cache', async () => {
    const first = await POST(request(), { params: Promise.resolve({ id: SUMMARY_ID }) });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      mode: 'translate',
      cached: false,
      chunks: [{ index: 0, content: '# Translated\n\nTranslated content.' }],
      complete: true,
    });
    expect(mocks.fetchAiEngine).toHaveBeenCalledTimes(1);
    expect(mocks.summaryUpdate).toHaveBeenCalledTimes(1);
  });

  it('returns a cached transform when the source hash is unchanged', async () => {
    const first = await POST(request(), { params: Promise.resolve({ id: SUMMARY_ID }) });
    expect(first.status).toBe(200);
    const updateCall = mocks.summaryUpdate.mock.calls[0]?.[0] as {
      data?: { originalMeta?: unknown };
    };
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUMMARY_ID,
      title: '公开雷达',
      body: '摘要',
      originalMarkdown: '# Original\n\nLong source content.',
      originalMeta: updateCall.data?.originalMeta ?? null,
      source: 'daily',
      syncRunId: 'run-1',
      shareSource: null,
    });
    const second = await POST(request(), { params: Promise.resolve({ id: SUMMARY_ID }) });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ cached: true });
    expect(mocks.fetchAiEngine).toHaveBeenCalledTimes(1);
  });
});
