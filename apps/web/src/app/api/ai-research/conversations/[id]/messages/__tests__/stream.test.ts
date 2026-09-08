import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const USER_MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const ASSISTANT_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  conversationFindUnique: vi.fn(),
  messageCreate: vi.fn(),
  conversationUpdate: vi.fn(),
  streamChatEngine: vi.fn(),
  loadResearchReportForJob: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/db', () => ({
  prisma: {
    aiResearchConversation: {
      findUnique: mocks.conversationFindUnique,
      update: mocks.conversationUpdate,
    },
    aiResearchConversationMessage: { create: mocks.messageCreate },
  },
}));
vi.mock('@/lib/chat-bff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-bff')>()),
  chatEngineUrl: (path: string) => `http://ai-engine.test${path}`,
  streamChatEngine: mocks.streamChatEngine,
}));
vi.mock('@/lib/research-chat-bff', () => ({
  loadResearchReportForJob: mocks.loadResearchReportForJob,
}));

import { POST } from '../stream/route';

function request(body: unknown): never {
  return new Request(`http://localhost/api/ai-research/conversations/${CONVERSATION_ID}/messages/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'admin' });
  mocks.conversationFindUnique.mockResolvedValue({
    id: CONVERSATION_ID,
    userId: USER_ID,
    jobId: JOB_ID,
    messages: [
      { role: 'user', content: '原问题', createdAt: new Date('2026-09-01T00:00:00.000Z') },
    ],
  });
  mocks.loadResearchReportForJob.mockResolvedValue({
    title: 'GraphRAG 调研',
    content: '# 报告\n结论',
    evidence: [{
      key: 'https://example.com/source',
      title: '官方来源',
      url: 'https://example.com/source',
      excerpt: '原文摘录',
      capturedAt: '2026-09-04T00:00:00.000Z',
      sourceType: 'web',
    }],
  });
  mocks.messageCreate
    .mockResolvedValueOnce({ id: USER_MESSAGE_ID })
    .mockResolvedValueOnce({ id: ASSISTANT_MESSAGE_ID });
  mocks.conversationUpdate.mockResolvedValue({ id: CONVERSATION_ID });
  mocks.streamChatEngine.mockResolvedValue(sseResponse(
    'event: start\ndata: {"ok":true}\n\n'
      + 'event: delta\ndata: "补充"\n\n'
      + 'event: done\ndata: {"content":"补充结论"}\n\n',
  ));
});

describe('POST /api/ai-research/conversations/[id]/messages/stream', () => {
  it('appends the persisted assistant UUID after the upstream stream completes', async () => {
    const response = await POST(request({ content: '请补充证据', intent: 'revise' }), {
      params: Promise.resolve({ id: CONVERSATION_ID }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.text();
    expect(body).toContain('event: done');
    expect(body).toContain(`event: persisted\ndata: {"ok":true,"message_id":"${ASSISTANT_MESSAGE_ID}"}`);
    expect(mocks.messageCreate).toHaveBeenNthCalledWith(1, {
      data: {
        conversationId: CONVERSATION_ID,
        role: 'user',
        content: '请补充证据',
        intent: 'revise',
      },
    });
    expect(mocks.messageCreate).toHaveBeenNthCalledWith(2, {
      data: {
        conversationId: CONVERSATION_ID,
        role: 'assistant',
        content: '补充结论',
        intent: 'revise',
      },
    });
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID },
      data: { updatedAt: expect.any(Date) },
    });
    expect(mocks.streamChatEngine).toHaveBeenCalledWith(
      'http://ai-engine.test/api/ai-research/chat/follow-up',
      expect.objectContaining({
        body: expect.stringContaining('"excerpt":"原文摘录"'),
      }),
      expect.any(String),
      'ai.bff.followup.stream',
    );
  });

  it('persists an interrupted answer so the transcript remains recoverable', async () => {
    mocks.streamChatEngine.mockResolvedValue(sseResponse('event: start\ndata: {"ok":true}\n\n'));

    const response = await POST(request({ content: '继续解释' }), {
      params: Promise.resolve({ id: CONVERSATION_ID }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.text()).toContain(`"message_id":"${ASSISTANT_MESSAGE_ID}"`);
    expect(mocks.messageCreate).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        role: 'assistant',
        content: '回答中断，请重试。',
        intent: 'answer',
      }),
    });
  });
});
