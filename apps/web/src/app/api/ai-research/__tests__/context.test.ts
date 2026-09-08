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
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
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

function request(query = 'GraphRAG') {
  return new Request(`http://localhost/api/ai-research/context?q=${encodeURIComponent(query)}`) as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'member' });
  mocks.researchFindMany.mockResolvedValue([]);
  mocks.topicIssueFindMany.mockResolvedValue([]);
  mocks.bookmarkFindMany.mockResolvedValue([]);
  mocks.summaryFindMany.mockResolvedValue([]);
  mocks.topicFindUnique.mockResolvedValue(null);
});

describe('GET /api/ai-research/context', () => {
  it('requires authentication', async () => {
    mocks.requireUser.mockResolvedValueOnce(new NextResponse(null, { status: 401 }));
    const response = await GET(request());
    expect(response.status).toBe(401);
  });

  it('searches personal research by content and returns a usable research ref', async () => {
    mocks.researchFindMany
      .mockResolvedValueOnce([{
        id: '22222222-2222-4222-8222-222222222222',
        title: 'GraphRAG 内部评估',
        status: 'draft',
        body: '正文里提到 GraphRAG 的索引成本。',
        background: null,
        conclusion: '先做小规模验证。',
        authorId: USER_ID,
        publishedAt: null,
      }])
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
    expect(where.AND[0].OR).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: expect.any(Object) }),
      expect.objectContaining({ conclusion: expect.any(Object) }),
    ]));
    expect(where.OR).toEqual([{ status: 'published' }, { authorId: USER_ID }]);
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
      .mockResolvedValueOnce([{
        id: '88888888-8888-4888-8888-888888888888',
        title: 'GraphRAG 评估记录',
        body: '索引成本与召回率的内部评估。',
        background: null,
        conclusion: '先做小规模验证。',
      }]);

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
  });
});
