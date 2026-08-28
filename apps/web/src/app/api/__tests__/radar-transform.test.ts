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

function request(mode: 'translate' | 'ai_reading' = 'translate', selection?: string) {
  return new Request(`http://localhost/api/radar/${SUMMARY_ID}/transform`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, language: 'zh-CN', ...(selection ? { selection } : {}) }),
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
    distilledTier: 'deep_read',
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
      distilledTier: 'deep_read',
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

  it('returns a server-anchored guide and stores it under the v4 cache key', async () => {
    mocks.fetchAiEngine.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        guide: {
          version: 2,
          summary: '一句话判断',
          outline: [{ heading: '问题', takeaway: '说明问题', quote: 'Long source content.' }],
          keyTakeaways: [{ claim: '关键观点', whyItMatters: '值得关注', evidence: '原文证据' }],
          implications: ['可能影响'],
          caveats: ['限制'],
          openQuestions: ['待验证'],
          highlights: [{ quote: '原文证据', rationale: '重要' }],
        },
      },
    });

    const response = await POST(request('ai_reading'), { params: Promise.resolve({ id: SUMMARY_ID }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      guide: { version: 2, summary: '一句话判断', keyTakeaways: [{ claim: '关键观点' }] },
      complete: true,
      guideVersion: 4,
      coverage: { outlineCount: 1, resolvedOutlineCount: 1 },
    });
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ operation: 'guide' }),
    }));
    const updateCall = mocks.summaryUpdate.mock.calls[0]?.[0] as {
      data?: { originalMeta?: { readingCache?: Record<string, unknown> } };
    };
    expect(updateCall.data?.originalMeta?.readingCache).toHaveProperty('ai_reading:v4:zh-CN');
    expect(updateCall.data?.originalMeta?.readingCache).not.toHaveProperty('ai_reading:v2:zh-CN');
  });

  it('recovers a fenced JSON guide returned as suggestion text', async () => {
    mocks.fetchAiEngine.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        suggestion: [
          '```json',
          '{"version":2,"summary":"恢复后的导读","outline":[{"heading":"第一部分","quote":"Long source content."}]}',
          '```',
        ].join('\n'),
      },
    });

    const response = await POST(request('ai_reading'), { params: Promise.resolve({ id: SUMMARY_ID }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      guide: {
        summary: '恢复后的导读',
        outline: [{ heading: '第一部分', anchorStatus: 'resolved', sourceBlockIndex: 1 }],
      },
    });
    expect(mocks.summaryUpdate).toHaveBeenCalledTimes(1);
  });

  it('continues long-guide sections after an intermediate section failure', async () => {
    const longBody = Array.from({ length: 250_000 }, (_, i) => i % 97 === 0 ? '\n## Section\n' : 'x').join('');
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUMMARY_ID,
      title: '长文',
      body: longBody,
      originalMarkdown: longBody,
      originalMeta: null,
      source: 'daily',
      syncRunId: 'run-1',
      distilledTier: 'deep_read',
      shareSource: null,
    });
    mocks.fetchAiEngine.mockImplementation(async ({ context }: { context: string }) => {
      if (context.endsWith('section.0')) return { ok: false, status: 502, code: 'UPSTREAM_UNAVAILABLE', message: 'section failed' };
      if (context.endsWith('synthesis')) return { ok: true, status: 200, body: { guide: { version: 2, summary: '综合结果', outline: [{ heading: '第二段' }] } } };
      return { ok: true, status: 200, body: { guide: { version: 2, outline: [{ heading: '后续段落' }] } } };
    });

    const response = await POST(request('ai_reading'), { params: Promise.resolve({ id: SUMMARY_ID }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      guide: { summary: '综合结果' },
      complete: false,
      failedChunkIndexes: [0],
    });
    expect(mocks.fetchAiEngine.mock.calls.some(([call]) => String(call.context).endsWith('section.1'))).toBe(true);
  });

  it('hides skim transforms from regular users', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUMMARY_ID,
      title: 'Skim article',
      body: 'summary',
      originalMarkdown: '# Full source',
      originalMeta: null,
      source: 'daily',
      syncRunId: 'run-1',
      distilledTier: 'skim',
      shareSource: null,
    });

    const response = await POST(request(), { params: Promise.resolve({ id: SUMMARY_ID }) });

    expect(response.status).toBe(404);
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
  });

  it('hides noise transforms from regular users', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUMMARY_ID,
      title: 'Noise',
      body: 'noise',
      originalMarkdown: '# Noise',
      originalMeta: null,
      source: 'daily',
      syncRunId: 'run-1',
      distilledTier: 'noise',
      shareSource: null,
    });

    const response = await POST(request('ai_reading'), { params: Promise.resolve({ id: SUMMARY_ID }) });

    expect(response.status).toBe(404);
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
  });

  it('translates only the selected passage without writing it into the article cache', async () => {
    const response = await POST(request('translate', 'Only this paragraph'), { params: Promise.resolve({ id: SUMMARY_ID }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ selected: true, complete: true, chunks: [{ index: 0 }] });
    expect(mocks.summaryUpdate).not.toHaveBeenCalled();
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ operation: 'translate', body: 'Only this paragraph' }),
    }));
  });

  it('strips an echoed editor prompt from a selected translation', async () => {
    mocks.fetchAiEngine.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        suggestion: [
          '主题：公开雷达',
          '上下文：最终的兼容性分数由两个层级加权得到。',
          '待处理文字：最终的兼容性分数由两个层级加权得到。',
          '要求：完整翻译输入内容。',
        ].join('\n'),
      },
    });
    const response = await POST(request('translate', 'The compatibility score uses two layers.'), { params: Promise.resolve({ id: SUMMARY_ID }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      chunks: [{ content: '最终的兼容性分数由两个层级加权得到。' }],
    });
  });

  it('explains a selected passage directly instead of running a generic guide', async () => {
    mocks.fetchAiEngine.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { suggestion: '平均保真度损失表示……' },
    });
    const response = await POST(request('ai_reading', 'Only this paragraph'), { params: Promise.resolve({ id: SUMMARY_ID }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ content: '平均保真度损失表示……', selected: true });
    expect(mocks.summaryUpdate).not.toHaveBeenCalled();
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ operation: 'explain', instruction: expect.stringContaining('不要只复述') }),
    }));
  });

  it('does not treat a provider-truncated selected translation as complete', async () => {
    mocks.fetchAiEngine.mockResolvedValue({
      ok: true,
      status: 200,
      body: { suggestion: 'partial', truncated: true, finishReason: 'max_tokens' },
    });
    const response = await POST(request('translate', 'A long selected paragraph'), { params: Promise.resolve({ id: SUMMARY_ID }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ selected: true, complete: false, failedChunkIndexes: [0], truncatedChunkIndexes: [0] });
  });
});
