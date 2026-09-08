import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  researchMessageFindUnique: vi.fn(),
  chatMessageFindUnique: vi.fn(),
  fetchAiEngine: vi.fn(),
  researchCreate: vi.fn(),
  researchSourceCreate: vi.fn(),
  researchAuditCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api-handler')>(),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/db', () => ({
  prisma: {
    aiResearchConversationMessage: { findUnique: mocks.researchMessageFindUnique },
    aiChatMessage: { findUnique: mocks.chatMessageFindUnique },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/env', () => ({
  getWebEnv: () => ({ AI_ENGINE_URL: 'http://ai.test', INTERNAL_SERVICE_TOKEN: '' }),
}));
vi.mock('@/lib/ai-bff/fetch-ai-engine', () => ({ fetchAiEngine: mocks.fetchAiEngine }));

import { POST as derivePost } from '../knowledge/derive/route';
import { POST as savePost } from '../knowledge/route';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'member@example.com',
  name: 'Member',
  image: null,
  role: 'member' as const,
  disabledAt: null,
};
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';

function researchMessage(userId = USER.id) {
  return {
    id: MESSAGE_ID,
    role: 'assistant',
    content: '回答中包含可以复用的判断。',
    conversation: {
      userId,
      title: 'AI 调研',
      jobId: JOB_ID,
      job: {
        topic: 'RAG',
        aiResearchSources: [{
          sourceRef: { type: 'url', value: 'https://example.com/evidence' },
          canonicalKey: 'https://example.com/evidence',
          title: '证据来源',
          snippet: '来源摘录',
        }],
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
  mocks.researchMessageFindUnique.mockResolvedValue(researchMessage());
  mocks.chatMessageFindUnique.mockResolvedValue(null);
  mocks.fetchAiEngine.mockResolvedValue({
    ok: true,
    status: 200,
    body: {
      card: {
        title: 'RAG 的检索边界',
        body: '先明确检索范围，再用来源证据约束生成结果。',
        conclusion: '知识卡片应保留适用边界。',
        tags: ['RAG', '证据'],
      },
      warnings: [],
    },
  });
  mocks.researchCreate.mockResolvedValue({
    id: '44444444-4444-4444-8444-444444444444',
    title: 'RAG 的检索边界',
    status: 'published',
    publishedAt: new Date('2026-09-04T00:00:00.000Z'),
  });
  mocks.transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({
    research: { create: mocks.researchCreate },
    researchSource: { create: mocks.researchSourceCreate },
    researchAudit: { create: mocks.researchAuditCreate },
  }));
});

describe('explicit knowledge-card flow', () => {
  it('derives a preview from an owned assistant message and server-side sources', async () => {
    const response = await derivePost(new Request('http://localhost/api/knowledge/derive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceKind: 'research_chat', messageId: MESSAGE_ID }),
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      preview: {
        title: 'RAG 的检索边界',
        body: '先明确检索范围，再用来源证据约束生成结果。',
      },
      source: { kind: 'research_chat', messageId: MESSAGE_ID, count: 1 },
    });
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      retry: false,
      body: expect.objectContaining({
        operation: 'knowledge_card',
        body: '回答中包含可以复用的判断。',
        sources: [expect.objectContaining({ canonicalKey: 'https://example.com/evidence' })],
      }),
    }));
  });

  it('rejects a message owned by another user before calling the model', async () => {
    mocks.researchMessageFindUnique.mockResolvedValue(researchMessage('99999999-9999-4999-8999-999999999999'));

    const response = await derivePost(new Request('http://localhost/api/knowledge/derive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceKind: 'research_chat', messageId: MESSAGE_ID }),
    }) as never);

    expect(response.status).toBe(403);
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
  });

  it('saves only after confirmation and records source provenance', async () => {
    const response = await savePost(new Request('http://localhost/api/knowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceKind: 'research_chat',
        messageId: MESSAGE_ID,
        title: 'RAG 的检索边界',
        body: '先明确检索范围，再用来源证据约束生成结果。',
        conclusion: '知识卡片应保留适用边界。',
        tags: ['RAG', '证据'],
      }),
    }) as never);

    expect(response.status).toBe(201);
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
    expect(mocks.researchCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'knowledge',
        status: 'published',
        creationMethod: 'ai_research',
        aiAssisted: true,
        originContentSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    }));
    expect(mocks.researchSourceCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        canonicalKey: 'https://example.com/evidence',
        title: '证据来源',
      }),
    }));
    expect(mocks.researchAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'create',
        diff: expect.objectContaining({ sourceMessageId: MESSAGE_ID }),
      }),
    }));
  });
});
