// AI 调研持久化对话 BFF —— 校验与归属测试。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  conversationFindUnique: vi.fn(),
  conversationUpdate: vi.fn(),
  conversationCreate: vi.fn(),
  messageCreate: vi.fn(),
  messageFindFirst: vi.fn(),
  transaction: vi.fn(),
  jobFindUnique: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({
  requireUser: mocks.requireUser,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: mocks.transaction,
    aiResearchConversation: {
      findUnique: mocks.conversationFindUnique,
      update: mocks.conversationUpdate,
      create: mocks.conversationCreate,
    },
    aiResearchConversationMessage: { create: mocks.messageCreate, findFirst: mocks.messageFindFirst },
    aiResearchJob: {
      findUnique: mocks.jobFindUnique,
    },
  },
}));

import { POST as createConversation } from '../route';
import { POST as appendMessages } from '../[id]/messages/route';
import { PATCH as patchConversation } from '../[id]/route';
import { Prisma } from '@prisma/client';

function request(url: string, body: unknown, method = 'POST') {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'member' });
  mocks.conversationUpdate.mockResolvedValue({});
  mocks.messageFindFirst.mockResolvedValue(null);
  mocks.messageCreate.mockImplementation(async ({ data }) => data);
  mocks.transaction.mockImplementation(async (run) => run({
    aiResearchConversation: { update: mocks.conversationUpdate },
    aiResearchConversationMessage: { create: mocks.messageCreate, findFirst: mocks.messageFindFirst },
  }));
});

describe('POST /api/ai-research/conversations', () => {
  it('assigns strictly increasing timestamps to the initial transcript', async () => {
    mocks.conversationCreate.mockImplementation(async ({ data }) => ({
      id: CONVERSATION_ID, jobId: null, title: data.title, status: 'active',
      createdAt: new Date(), updatedAt: new Date(), _count: { messages: 3 },
      messages: data.messages.create.map((message: object, index: number) => ({
        id: String(3 - index), ...message,
      })),
    }));
    const res = await createConversation(request('/api/ai-research/conversations', {
      title: 'Grok Bot',
      messages: [
        { role: 'assistant', content: 'Welcome' },
        { role: 'user', content: 'Grok Bot' },
        { role: 'assistant', content: 'Ready' },
      ],
    }));
    expect(res.status).toBe(201);
    const payload = await res.json();
    expect(payload.messages.map((message: { content: string }) => message.content))
      .toEqual(['Welcome', 'Grok Bot', 'Ready']);
    const inserted = mocks.conversationCreate.mock.calls[0]![0].data.messages.create;
    expect(inserted[0].createdAt.getTime()).toBeLessThan(inserted[1].createdAt.getTime());
    expect(inserted[1].createdAt.getTime()).toBeLessThan(inserted[2].createdAt.getTime());
  });

  it('rejects an empty title', async () => {
    const res = await createConversation(request('/api/ai-research/conversations', { title: '  ' }));
    const payload = await res.json();
    expect(res.status).toBe(400);
    expect(payload.code).toBe('VALIDATION_FAILED');
    expect(mocks.conversationUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai-research/conversations/[id]/messages', () => {
  it('returns 404 when the conversation belongs to another user', async () => {
    mocks.conversationFindUnique.mockResolvedValue({ userId: 'someone-else' });
    const res = await appendMessages(
      request(`/api/ai-research/conversations/${CONVERSATION_ID}/messages`, {
        messages: [{ role: 'user', content: '研究 GraphRAG' }],
      }),
      { params: Promise.resolve({ id: CONVERSATION_ID }) },
    );
    const payload = await res.json();
    expect(res.status).toBe(404);
    expect(payload.code).toBe('AI_JOB_NOT_FOUND');
  });

  it('appends planning messages for the owner', async () => {
    mocks.conversationFindUnique.mockResolvedValue({ userId: USER_ID });
    mocks.conversationFindUnique.mockResolvedValueOnce({ userId: USER_ID });
    mocks.conversationFindUnique.mockResolvedValueOnce({
      id: CONVERSATION_ID,
      jobId: null,
      title: '研究 GraphRAG',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { messages: 2 },
      messages: [
        { id: 'a', role: 'user', content: '研究 GraphRAG', createdAt: new Date() },
        { id: 'b', role: 'assistant', content: '请补充背景', createdAt: new Date() },
      ],
    });
    const res = await appendMessages(
      request(`/api/ai-research/conversations/${CONVERSATION_ID}/messages`, {
        messages: [
          { role: 'user', content: '研究 GraphRAG' },
          { role: 'assistant', content: '请补充背景' },
        ],
      }),
      { params: Promise.resolve({ id: CONVERSATION_ID }) },
    );
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.messages).toHaveLength(2);
    expect(mocks.messageCreate).toHaveBeenNthCalledWith(1, {
      data: { conversationId: CONVERSATION_ID, role: 'user', content: '研究 GraphRAG', createdAt: expect.any(Date) },
    });
    expect(mocks.messageCreate.mock.calls[1]![0].data.createdAt.getTime())
      .toBeGreaterThan(mocks.messageCreate.mock.calls[0]![0].data.createdAt.getTime());
  });
});

describe('PATCH /api/ai-research/conversations/[id]', () => {
  it('maps a duplicate jobId (unique violation) to 409 instead of 500', async () => {
    const JOB_ID = '33333333-3333-4333-8333-333333333333';
    mocks.conversationFindUnique.mockResolvedValue({ userId: USER_ID });
    mocks.jobFindUnique.mockResolvedValue({ requesterId: USER_ID });
    mocks.conversationUpdate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
    );
    const res = await patchConversation(
      request(`/api/ai-research/conversations/${CONVERSATION_ID}`, { jobId: JOB_ID }, 'PATCH'),
      { params: Promise.resolve({ id: CONVERSATION_ID }) },
    );
    expect(res.status).toBe(409);
  });
});
