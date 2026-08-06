import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@deep-research/shared/errors';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  researchFindUnique: vi.fn(),
  fetchAiEngine: vi.fn(),
  getWebEnv: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));

vi.mock('../../../lib/auth/session.js', () => ({ requireUser: mocks.requireUser }));
vi.mock('../../../lib/db.js', () => ({
  prisma: { research: { findUnique: mocks.researchFindUnique } },
}));
vi.mock('../../../lib/ai-bff/fetch-ai-engine.js', () => ({ fetchAiEngine: mocks.fetchAiEngine }));
vi.mock('../../../lib/env.js', () => ({ getWebEnv: mocks.getWebEnv }));

import { POST } from '../researches/[id]/assistant/route';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'member@example.com',
  name: 'Member',
  image: null,
  role: 'member' as const,
  disabledAt: null,
};
const RESEARCH_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
  mocks.getWebEnv.mockReturnValue({ AI_ENGINE_URL: 'http://localhost:4000' });
  mocks.researchFindUnique.mockResolvedValue({
    id: RESEARCH_ID,
    title: '研究主题',
    body: '正文上下文选中的文本',
    status: 'draft',
    authorId: USER.id,
    researchSources: [],
  });
  mocks.fetchAiEngine.mockResolvedValue({
    ok: true,
    status: 200,
    body: {
      operation: 'rewrite',
      original: '选中的文本',
      suggestion: '改写后的文本',
      rationale: '更清晰',
      claims: [],
      warnings: [],
    },
  });
});

describe('POST /api/researches/[id]/assistant', () => {
  it('converts the web anchor contract to the Python snake_case contract', async () => {
    const response = await POST(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'rewrite',
          selection: {
            quote: '选中的文本',
            startOffset: 5,
            endOffset: 10,
            contentHash: createHash('sha256').update('正文上下文选中的文本').digest('hex'),
          },
        }),
      }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        body: '正文上下文选中的文本',
        topic: '研究主题',
        selection: {
          quote: '选中的文本',
          start_offset: 5,
          end_offset: 10,
          content_hash: createHash('sha256').update('正文上下文选中的文本').digest('hex'),
        },
      }),
    }));
  });

  it('does not require a selection for whole-draft checks', async () => {
    const response = await POST(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'conclusion_check' }),
      }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ selection: undefined }),
    }));
  });

  it('rejects a selection whose content hash or offsets are stale', async () => {
    const response = await POST(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'rewrite',
          selection: {
            quote: '旧文本',
            startOffset: 0,
            endOffset: 3,
            contentHash: 'b'.repeat(64),
          },
        }),
      }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
  });

  it('caps the context sent to the synchronous engine', async () => {
    const body = 'x'.repeat(35_000);
    mocks.researchFindUnique.mockResolvedValueOnce({
      id: RESEARCH_ID,
      title: '研究主题',
      body,
      status: 'draft',
      authorId: USER.id,
      researchSources: [],
    });

    const response = await POST(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'summarize' }),
      }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ body: 'x'.repeat(30_000) }),
    }));
  });

  it('returns upstream validation details instead of disguising them as downtime', async () => {
    mocks.fetchAiEngine.mockResolvedValueOnce({
      ok: false,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'AI 请求参数不合法，请重新选择文本后重试',
      requestId: 'upstream-req',
      details: [{ location: ['body', 'selection'], message: 'Field required' }],
    });

    const response = await POST(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'rewrite' }),
      }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'AI 请求参数不合法，请重新选择文本后重试',
      details: [{ location: ['body', 'selection'], message: 'Field required' }],
    });
  });
});
