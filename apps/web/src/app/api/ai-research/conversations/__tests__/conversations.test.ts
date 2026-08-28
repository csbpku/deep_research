// AI 调研持久化对话 BFF —— 校验与归属测试。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  conversationFindUnique: vi.fn(),
  conversationUpdate: vi.fn(),
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
    aiResearchConversation: {
      findUnique: mocks.conversationFindUnique,
      update: mocks.conversationUpdate,
    },
    aiResearchJob: {
      findUnique: mocks.jobFindUnique,
    },
  },
}));

import { POST as createConversation } from '../route';
import { POST as appendMessages } from '../[id]/messages/route';

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
});

describe('POST /api/ai-research/conversations', () => {
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
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID },
      data: {
        messages: {
          create: [
            { role: 'user', content: '研究 GraphRAG' },
            { role: 'assistant', content: '请补充背景' },
          ],
        },
      },
    });
  });
});
