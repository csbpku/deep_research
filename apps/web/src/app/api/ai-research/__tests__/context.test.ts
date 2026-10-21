import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  researchFindMany: vi.fn(),
  topicIssueFindMany: vi.fn(),
  bookmarkFindMany: vi.fn(),
  summaryFindMany: vi.fn(),
  topicFindUnique: vi.fn(),
  fetchAiEngine: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/env', () => ({ getWebEnv: () => ({ AI_ENGINE_URL: 'http://ai.test', INTERNAL_SERVICE_TOKEN: 'internal' }) }));
vi.mock('@/lib/ai-bff/fetch-ai-engine', () => ({ fetchAiEngine: mocks.fetchAiEngine }));
vi.mock('@/lib/db', () => ({
  prisma: {
    research: { findMany: mocks.researchFindMany },
    summary: { findMany: mocks.summaryFindMany },
    topicIssue: { findMany: mocks.topicIssueFindMany },
    userBookmark: { findMany: mocks.bookmarkFindMany },
    topic: { findUnique: mocks.topicFindUnique },
  },
}));

import { GET } from '../context/route';

function request(query = 'GraphRAG', params: Record<string, string> = {}) {
  return new Request(`http://localhost/api/ai-research/context?${new URLSearchParams({ q: query, ...params })}`) as never;
}

function research(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222', title: 'GraphRAG 内部评估',
    type: 'research', status: 'draft', body: 'GraphRAG 索引成本。',
    background: null, conclusion: '先做小规模验证。', authorId: USER_ID,
    knowledgeIndexText: null, researchTopics: [], updatedAt: new Date('2026-10-19T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'member' });
  mocks.researchFindMany.mockResolvedValue([]);
  mocks.topicIssueFindMany.mockResolvedValue([]);
  mocks.bookmarkFindMany.mockResolvedValue([]);
  mocks.summaryFindMany.mockResolvedValue([]);
  mocks.topicFindUnique.mockResolvedValue(null);
  mocks.fetchAiEngine.mockResolvedValue({ ok: false, code: 'AI_ENGINE_UNAVAILABLE', requestId: 'req', message: 'unavailable' });
});

describe('GET /api/ai-research/context', () => {
  it('requires authentication', async () => {
    mocks.requireUser.mockResolvedValueOnce(new NextResponse(null, { status: 401 }));
    const response = await GET(request());
    expect(response.status).toBe(401);
  });

  it('searches personal research by content and returns a usable research ref', async () => {
    mocks.researchFindMany
      .mockResolvedValueOnce([research({
        id: '22222222-2222-4222-8222-222222222222',
        title: 'GraphRAG 内部评估',
        status: 'draft',
        body: '正文里提到 GraphRAG 的索引成本。',
        background: null,
        conclusion: '先做小规模验证。',
        authorId: USER_ID,
        publishedAt: null,
      })])
      .mockResolvedValueOnce([]);

    const response = await GET(request('索引成本'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'research',
        id: '22222222-2222-4222-8222-222222222222',
        private: true,
        sourceRefs: [{
          type: 'research',
          value: '22222222-2222-4222-8222-222222222222',
          required: false,
        }],
      }),
    ]));

    const where = mocks.researchFindMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: expect.any(Object) }),
      expect.objectContaining({ conclusion: expect.any(Object) }),
    ]));
    expect(where.authorId).toBe(USER_ID);
    expect(where.status).toEqual({ in: ['draft', 'published'] });
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
  });

  it('uses semantic results as IDs, then rechecks current owner and draft status in Postgres', async () => {
    const privateId = '22222222-2222-4222-8222-222222222222';
    mocks.fetchAiEngine.mockResolvedValueOnce({ ok: true, status: 200, body: { ids: [privateId] } });
    mocks.researchFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: privateId,
        title: '我确认过的检索结论',
        body: '数据库中的真实草稿正文。',
        conclusion: '数据库中的判断。',
        knowledgeIndexText: '数据库中的判断。',
        updatedAt: new Date('2026-09-24T00:00:00Z'),
      }]);

    const response = await GET(request('向量检索成本', { semantic: '1' }));
    const body = await response.json();
    expect(body.items[0]).toMatchObject({
      kind: 'knowledge',
      id: privateId,
      title: '我确认过的检索结论',
      snippet: '数据库中的判断。',
      private: true,
      semanticMatch: true,
    });
    expect(JSON.stringify(body)).not.toContain('AnythingLLM 返回的文本');
    expect(mocks.researchFindMany.mock.calls[2][0].where).toMatchObject({
      id: { in: [privateId] },
      authorId: USER_ID,
      type: 'knowledge',
      status: 'draft',
      knowledgeIndexText: { not: null },
    });
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      body: { userId: USER_ID, query: '向量检索成本', limit: 4 },
      retry: false,
    }));
  });

  it('keeps keyword-matched private knowledge when semantic search is unavailable', async () => {
    const privateId = '22222222-2222-4222-8222-222222222222';
    mocks.fetchAiEngine.mockRejectedValueOnce(new Error('synthetic timeout'));
    mocks.researchFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([research({
        id: privateId,
        title: '索引故障时仍可关键词回退',
        type: 'knowledge',
        knowledgeIndexText: '搜索降级不能阻断调研。',
        status: 'draft',
        body: '保留数据库关键词搜索作为降级路径。',
        background: null,
        conclusion: '搜索降级不能阻断调研。',
        authorId: USER_ID,
        publishedAt: null,
      })]);

    const response = await GET(request('关键词回退', { semantic: '1' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'knowledge',
        id: privateId,
        private: true,
      }),
    ]));
    expect(body.items[0].semanticMatch).toBeUndefined();
  });

  it('drops semantic IDs that are not owned private knowledge drafts', async () => {
    const anotherUsersId = '99999999-9999-4999-8999-999999999999';
    mocks.fetchAiEngine.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { ids: [anotherUsersId] },
    });
    mocks.researchFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const response = await GET(request('跨账号向量结果', { semantic: '1' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items).toEqual([]);
    expect(mocks.researchFindMany.mock.calls[2][0].where).toMatchObject({
      id: { in: [anotherUsersId] },
      authorId: USER_ID,
      type: 'knowledge',
      status: 'draft',
    });
  });

  it('deduplicates a private knowledge item found by both semantic and keyword search', async () => {
    const privateId = '22222222-2222-4222-8222-222222222222';
    mocks.fetchAiEngine.mockResolvedValueOnce({ ok: true, status: 200, body: { ids: [privateId] } });
    mocks.researchFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([research({
        id: privateId,
        title: '相同的私人知识',
        type: 'knowledge',
        knowledgeIndexText: '已确认的判断。',
        status: 'draft',
        body: '关键词匹配的正文。',
        background: null,
        conclusion: '已确认的判断。',
        authorId: USER_ID,
        publishedAt: null,
      })])
      .mockResolvedValueOnce([{
        id: privateId,
        title: '相同的私人知识',
        body: '关键词匹配的正文。',
        conclusion: '已确认的判断。',
        knowledgeIndexText: '已确认的判断。',
        updatedAt: new Date('2026-09-24T00:00:00Z'),
      }]);

    const response = await GET(request('已确认的判断', { semantic: '1' }));
    const body = await response.json();
    const matches = body.items.filter((item: { id: string }) => item.id === privateId);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ kind: 'knowledge', private: true, semanticMatch: true });
  });

  it('turns a matched topic issue into the candidate summary refs that the worker can resolve', async () => {
    mocks.topicIssueFindMany.mockResolvedValueOnce([{
      id: '33333333-3333-4333-8333-333333333333',
      title: 'GraphRAG 索引成本变化',
      proposition: '近期多个团队报告索引成本上升。',
      candidates: [
        { summaryId: '44444444-4444-4444-8444-444444444444' },
        { summaryId: '55555555-5555-4555-8555-555555555555' },
      ],
      topic: { id: '66666666-6666-4666-8666-666666666666', slug: 'rag', name: 'RAG' },
    }]);

    const response = await GET(request('索引成本'));
    const body = await response.json();
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'issue',
        sourceRefs: [
          { type: 'summary', value: '44444444-4444-4444-8444-444444444444', required: false },
          { type: 'summary', value: '55555555-5555-4555-8555-555555555555', required: false },
        ],
      }),
    ]));
  });

  it('hydrates a matching bookmark into the actual research source ref', async () => {
    mocks.bookmarkFindMany.mockResolvedValueOnce([{
      id: '77777777-7777-4777-8777-777777777777',
      note: null,
      targetType: 'research',
      targetId: '88888888-8888-4888-8888-888888888888',
      createdAt: new Date('2026-09-01T00:00:00Z'),
    }]);
    mocks.researchFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([research({
        id: '88888888-8888-4888-8888-888888888888',
        title: 'GraphRAG 评估记录',
        body: '索引成本与召回率的内部评估。',
        background: null,
        conclusion: '先做小规模验证。',
      })]);

    const response = await GET(request('评估记录'));
    const body = await response.json();
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'bookmark',
        title: 'GraphRAG 评估记录',
        sourceRefs: [{
          type: 'research',
          value: '88888888-8888-4888-8888-888888888888',
          required: false,
        }],
      }),
    ]));
    expect(mocks.researchFindMany.mock.calls[2][0].where).toMatchObject({
      id: { in: ['88888888-8888-4888-8888-888888888888'] },
      OR: [
        { status: 'published' },
        { authorId: USER_ID, status: 'draft' },
      ],
    });
  });

  it('propagates topic hints into bounded local matching without semantic search', async () => {
    const topicHint = '66666666-6666-4666-8666-666666666666';
    mocks.researchFindMany.mockResolvedValueOnce([research({
      type: 'knowledge', title: '以前确认的架构取舍', body: '',
      knowledgeIndexText: '先保留现有方案。', researchTopics: [{ topicId: topicHint }],
    })]);
    const response = await GET(request('接下来如何验证新方案', { topicHint }));
    const body = await response.json();
    expect(body.items[0]).toMatchObject({
      kind: 'knowledge', confirmedKnowledge: true, topicMatch: true,
      snippet: '先保留现有方案。', status: 'draft', updatedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(mocks.researchFindMany.mock.calls[0][0].where.OR).toContainEqual({
      researchTopics: { some: { topicId: { in: [topicHint] } } },
    });
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
  });

  it('keeps public published research discoverable in explicit manual search', async () => {
    mocks.researchFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      research({ status: 'published', authorId: 'another-user' }),
      research({ id: 'other-private', authorId: 'another-user' }),
      research({ id: 'archived', status: 'archived' }),
    ]);
    const response = await GET(request('GraphRAG', { manual: '1' }));
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ private: false, status: 'published' });
    expect(mocks.researchFindMany.mock.calls[1][0].where.AND[0].OR).toContainEqual({ status: 'published' });
  });

  it('does not run unbounded discovery for boilerplate or oversized questions', async () => {
    const response = await GET(request('如何？'));
    expect((await response.json()).items).toEqual([]);
    expect(mocks.researchFindMany).not.toHaveBeenCalled();
    await GET(request(`${'GraphRAG '.repeat(500)} sentinel`));
    const firstQuery = JSON.stringify(mocks.researchFindMany.mock.calls[0][0]);
    expect(firstQuery).not.toContain('sentinel');
    expect(mocks.researchFindMany.mock.calls[0][0].take).toBe(24);
  });
});
