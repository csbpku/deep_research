import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireReadingUser: vi.fn(),
  transaction: vi.fn(),
  findFirst: vi.fn(),
  researchCreate: vi.fn(),
  researchSourceCreate: vi.fn(),
  researchAuditCreate: vi.fn(),
  indexTaskUpsert: vi.fn(),
  researchFindFirst: vi.fn(),
  researchUpdateMany: vi.fn(),
  researchFindUnique: vi.fn(),
  researchSourceUpdateMany: vi.fn(),
}));

vi.mock('../../../../lib/api-handler', () => ({
  apiHandler: (handler: unknown) => handler,
  parseBody: async (req: Request, schema: { parse: (value: unknown) => unknown }) => schema.parse(await req.json()),
}));
vi.mock('../../../../lib/reading-auth', () => ({ requireReadingUser: mocks.requireReadingUser }));
vi.mock('../../../../lib/db', () => ({
  prisma: { $transaction: mocks.transaction, research: { findFirst: mocks.findFirst } },
}));

import { POST, PUT } from '../save/route';

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'reader@example.com', role: 'member' as const };
const body = 'A paragraph from the original page.';
const validAnchor = {
  quote: body,
  prefix: '',
  suffix: '',
  startOffset: 0,
  endOffset: body.length,
  contentHash: 'a'.repeat(64),
};

function request(input: unknown, method = 'POST'): Request {
  return new Request('http://localhost/api/reading/save', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireReadingUser.mockResolvedValue(USER);
  mocks.researchCreate.mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', title: 'Docs', status: 'draft', createdAt: new Date() });
  mocks.researchFindFirst.mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', researchSources: [{ id: 'original-source' }] });
  mocks.researchUpdateMany.mockResolvedValue({ count: 1 });
  mocks.researchFindUnique.mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', title: 'Docs', status: 'draft', createdAt: new Date() });
  mocks.transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({
    research: { create: mocks.researchCreate, findFirst: mocks.researchFindFirst, updateMany: mocks.researchUpdateMany, findUniqueOrThrow: mocks.researchFindUnique },
    researchSource: { create: mocks.researchSourceCreate, updateMany: mocks.researchSourceUpdateMany },
    researchAudit: { create: mocks.researchAuditCreate },
    personalKnowledgeIndexTask: { upsert: mocks.indexTaskUpsert },
  }));
});

describe('PUT /api/reading/save', () => {
  const input = { url: 'https://example.com/docs', title: 'Docs', quote: body, note: 'Edited note', idempotencyKey: '33333333-3333-4333-8333-333333333333' };

  it('updates the owned draft, source and index without creating another research', async () => {
    const response = await PUT(request(input, 'PUT') as never);
    expect(response.status).toBe(200);
    expect((await response.json()).updated).toBe(true);
    expect(mocks.researchCreate).not.toHaveBeenCalled();
    expect(mocks.researchUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ authorId: USER.id, status: 'draft', readingSaveKey: input.idempotencyKey }),
      data: expect.objectContaining({ body: expect.stringContaining('Edited note') }),
    }));
    expect(mocks.researchSourceUpdateMany).toHaveBeenCalled();
    expect(mocks.researchSourceUpdateMany.mock.calls[0][0].where.id).toBe('original-source');
    expect(mocks.researchAuditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'update' }) }));
  });

  it('does not update missing, other-owner or published records', async () => {
    mocks.researchFindFirst.mockResolvedValue(null);
    const response = await PUT(request(input, 'PUT') as never);
    expect(response.status).toBe(404);
    expect(mocks.researchFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ authorId: USER.id, status: 'draft', type: 'knowledge' }) }));
    expect(mocks.researchUpdateMany).not.toHaveBeenCalled();
  });

  it('blocks a concurrent publish before changing the source or index', async () => {
    mocks.researchUpdateMany.mockResolvedValue({ count: 0 });
    const response = await PUT(request(input, 'PUT') as never);
    expect(response.status).toBe(404);
    expect(mocks.researchSourceUpdateMany).not.toHaveBeenCalled();
    expect(mocks.indexTaskUpsert).not.toHaveBeenCalled();
  });

  it('queues removal of stale indexed notes when edited content clears them', async () => {
    await PUT(request({ ...input, note: '' }, 'PUT') as never);
    expect(mocks.indexTaskUpsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ operation: 'delete' }) }));
  });

  it('requires the original save key', async () => {
    const response = await PUT(request({ ...input, idempotencyKey: undefined }, 'PUT') as never);
    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/reading/save', () => {
  it('rejects an edited quote while retaining the old anchor', async () => {
    const response = await POST(request({
      url: 'https://example.com/docs',
      title: 'Docs',
      quote: 'An edited paragraph.',
      anchor: validAnchor,
    }) as never);
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain('锚点');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects an incomplete anchor instead of saving an unverifiable citation', async () => {
    const response = await POST(request({
      url: 'https://example.com/docs',
      title: 'Docs',
      quote: body,
      anchor: { quote: body },
    }) as never);
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain('位置或内容指纹');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('stores an excerpt without enqueueing it for vector indexing', async () => {
    const response = await POST(request({
      url: 'https://example.com/docs',
      title: 'Docs',
      quote: body,
      note: '',
    }) as never);

    expect(response.status).toBe(201);
    expect(mocks.researchCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ knowledgeIndexText: null }),
    }));
    expect(mocks.indexTaskUpsert).not.toHaveBeenCalled();
  });

  it('indexes only the confirmed note and AI conclusion, never the quoted source', async () => {
    const response = await POST(request({
      url: 'https://example.com/docs',
      title: 'Docs',
      quote: body,
      note: '我的判断是先限制索引范围。',
      aiAnswer: '确认的结论是小规模验证成本。',
    }) as never);

    expect(response.status).toBe(201);
    const create = mocks.researchCreate.mock.calls[0][0] as { data: { knowledgeIndexText: string; conclusion: string } };
    expect(create.data.knowledgeIndexText).toContain('我的判断是先限制索引范围。');
    expect(create.data.knowledgeIndexText).toContain('确认的 AI 结论');
    expect(create.data.knowledgeIndexText).not.toContain(body);
    expect(create.data.conclusion).toContain('我的笔记');
    expect(mocks.indexTaskUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ operation: 'upsert' }),
    }));
  });
});
