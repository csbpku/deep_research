import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const RESEARCH_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';
const CREATED_AT = new Date('2026-09-01T00:00:00.000Z');

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  researchFindUnique: vi.fn(),
  researchUpdate: vi.fn(),
  aiResearchJobUpdate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  messageFindUnique: vi.fn(),
  conversationFindUnique: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/db', () => ({
  prisma: {
    research: {
      findUnique: mocks.researchFindUnique,
      update: mocks.researchUpdate,
    },
    researchAudit: { findMany: vi.fn(), create: mocks.auditCreate },
    aiResearchConversationMessage: { findUnique: mocks.messageFindUnique },
    aiResearchConversation: { findUnique: mocks.conversationFindUnique },
    $transaction: mocks.transaction,
  },
}));

import { PUT } from '../researches/[id]/route';

function request(body: unknown): never {
  return new Request(`http://localhost/api/researches/${RESEARCH_ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

function updatedResearch() {
  return {
    id: RESEARCH_ID,
    type: 'research',
    status: 'draft',
    title: 'GraphRAG 调研',
    body: '原报告\n\n## 追问补充\n\n补充结论',
    background: null,
    conclusion: null,
    risks: null,
    tags: [],
    authorId: USER_ID,
    creationMethod: 'ai_research',
    aiAssisted: true,
    originContentSha256: null,
    reviewStatus: null,
    reviewAttempts: 0,
    reviewSummary: null,
    reviewClaims: [],
    reviewedAt: null,
    reviewDetails: null,
    publishedAt: null,
    featuredAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    author: { id: USER_ID, name: 'Admin', email: 'admin@example.com' },
    _count: { comments: 0 },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'admin' });
  mocks.researchFindUnique.mockResolvedValue({
    id: RESEARCH_ID,
    title: 'GraphRAG 调研',
    body: '原报告',
    background: null,
    conclusion: null,
    risks: null,
    tags: [],
    authorId: USER_ID,
    status: 'draft',
    creationMethod: 'ai_research',
    aiAssisted: true,
    sourceAiJob: {
      id: JOB_ID,
      requesterId: USER_ID,
      aiResearchSources: [{
        sourceRef: { type: 'url', value: 'https://example.com/graphrag' },
        canonicalKey: 'https://example.com/graphrag',
        title: 'Official GraphRAG docs',
        createdAt: CREATED_AT,
      }],
    },
  });
  mocks.messageFindUnique.mockResolvedValue({
    id: MESSAGE_ID,
    role: 'assistant',
    intent: 'revise',
    createdAt: CREATED_AT,
    conversation: { id: CONVERSATION_ID, userId: USER_ID, jobId: JOB_ID },
  });
  mocks.conversationFindUnique.mockResolvedValue({
    messages: [{ content: '请补充 GraphRAG 的索引成本和适用边界。' }],
  });
  mocks.researchUpdate.mockResolvedValue(updatedResearch());
  mocks.aiResearchJobUpdate.mockResolvedValue({ id: JOB_ID });
  mocks.auditCreate.mockResolvedValue({ id: 'audit-1' });
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    research: { update: mocks.researchUpdate },
    aiResearchJob: { update: mocks.aiResearchJobUpdate },
    researchAudit: { create: mocks.auditCreate },
  }));
});

describe('PUT /api/researches/[id] follow-up revision provenance', () => {
  it('resolves the question and captured sources server-side before recording the revision', async () => {
    const response = await PUT(request({
      body: '原报告\n\n## 追问补充\n\n补充结论',
      revisionContext: {
        sourceMessageId: MESSAGE_ID,
        reason: '补充成本与适用边界',
      },
    }), { params: Promise.resolve({ id: RESEARCH_ID }) });

    expect(response.status).toBe(200);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        researchId: RESEARCH_ID,
        editorId: USER_ID,
        action: 'edit',
        sourceMessageId: MESSAGE_ID,
        sourceIntent: 'revise',
        sourceQuestion: '请补充 GraphRAG 的索引成本和适用边界。',
        reason: '补充成本与适用边界',
        sourceRefs: [{
          sourceRef: { type: 'url', value: 'https://example.com/graphrag' },
          canonicalKey: 'https://example.com/graphrag',
          title: 'Official GraphRAG docs',
          capturedAt: CREATED_AT.toISOString(),
        }],
      }),
    });
  });

  it('rejects a message from another research job without changing the document', async () => {
    mocks.messageFindUnique.mockResolvedValueOnce({
      id: MESSAGE_ID,
      role: 'assistant',
      intent: 'revise',
      createdAt: CREATED_AT,
      conversation: { id: CONVERSATION_ID, userId: USER_ID, jobId: '66666666-6666-4666-8666-666666666666' },
    });

    const response = await PUT(request({
      body: '篡改正文',
      revisionContext: { sourceMessageId: MESSAGE_ID },
    }), { params: Promise.resolve({ id: RESEARCH_ID }) });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.researchUpdate).not.toHaveBeenCalled();
  });

  it('rejects an ordinary answer even when the client labels it as a revision', async () => {
    mocks.messageFindUnique.mockResolvedValueOnce({
      id: MESSAGE_ID,
      role: 'assistant',
      intent: 'answer',
      createdAt: CREATED_AT,
      conversation: { id: CONVERSATION_ID, userId: USER_ID, jobId: JOB_ID },
    });

    const response = await PUT(request({
      body: '不应写入正文',
      revisionContext: { sourceMessageId: MESSAGE_ID, reason: '伪造修订意图' },
    }), { params: Promise.resolve({ id: RESEARCH_ID }) });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.researchUpdate).not.toHaveBeenCalled();
  });

  it('invalidates the old review and its async claim when the draft changes', async () => {
    mocks.researchFindUnique.mockResolvedValueOnce({
      id: RESEARCH_ID,
      title: 'GraphRAG 调研',
      body: '原报告',
      background: null,
      conclusion: null,
      risks: null,
      tags: [],
      authorId: USER_ID,
      status: 'draft',
      creationMethod: 'ai_research',
      aiAssisted: true,
      reviewStatus: 'passed',
      sourceAiJob: { id: JOB_ID, requesterId: USER_ID, aiResearchSources: [] },
    });

    const response = await PUT(request({ body: '修改后的报告' }), {
      params: Promise.resolve({ id: RESEARCH_ID }),
    });

    expect(response.status).toBe(200);
    expect(mocks.researchUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        reviewStatus: null,
        reviewAttempts: 0,
        reviewClaims: [],
        reviewedAt: null,
      }),
    }));
    expect(mocks.aiResearchJobUpdate).toHaveBeenCalledWith({
      where: { id: JOB_ID },
      data: expect.objectContaining({
        reviewStatus: null,
        reviewAttempts: 0,
        reviewStartedAt: null,
        reviewClaims: [],
      }),
    });
  });
});
