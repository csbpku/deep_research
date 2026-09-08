import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RESEARCH_ID = '22222222-2222-4222-8222-222222222222';
const REVISION_ID = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  researchFindUnique: vi.fn(),
  researchCreate: vi.fn(),
  researchCitationCreateMany: vi.fn(),
  researchReviewRunCreate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('../../../lib/auth/session.js', () => ({
  requireUser: vi.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', role: 'admin' }),
}));
vi.mock('../../../lib/db.js', () => ({
  prisma: {
    research: { findUnique: mocks.researchFindUnique },
    $transaction: mocks.transaction,
  },
}));

import { POST as forkPost } from '../researches/[id]/fork/route';
import { PUT as researchPut } from '../researches/[id]/route';

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function publishedAiResearch() {
  return {
    id: RESEARCH_ID,
    type: 'research',
    status: 'published',
    title: 'AI 研究',
    body: '# 原始研究\n\n结论',
    background: '背景',
    conclusion: '结论',
    risks: '风险',
    tags: ['ai'],
    authorId: USER_ID,
    creationMethod: 'ai_research',
    aiAssisted: true,
    sourceCommentId: null,
    researchSources: [{
      sourceRef: { type: 'url', value: 'https://example.com/docs' },
      canonicalKey: 'https://example.com/docs',
      title: '官方文档',
      description: '原文',
      citations: [{
        marker: '[^1]',
        quote: '结论',
        startOffset: 15,
        endOffset: 17,
        contentHash: 'a'.repeat(64),
      }],
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => callback({
    research: { create: mocks.researchCreate },
    researchCitation: { createMany: mocks.researchCitationCreateMany },
    researchReviewRun: { create: mocks.researchReviewRunCreate },
    researchAudit: { create: mocks.auditCreate },
  }));
  mocks.researchCreate.mockResolvedValue({
    id: REVISION_ID,
    type: 'research',
    status: 'draft',
    title: 'AI 研究',
    body: '# 原始研究\n\n结论',
    background: '背景',
    conclusion: '结论',
    risks: '风险',
    tags: ['ai'],
    authorId: USER_ID,
    creationMethod: 'ai_research',
    aiAssisted: false,
    supersedesResearchId: RESEARCH_ID,
    publishedAt: null,
    createdAt: new Date('2026-09-04T00:00:00Z'),
    updatedAt: new Date('2026-09-04T00:00:00Z'),
    researchSources: [{ id: 'source-copy-1', canonicalKey: 'https://example.com/docs' }],
    author: { id: USER_ID, name: 'Admin', email: 'admin@example.com' },
  });
});

describe('published AI research revision boundary', () => {
  it('forks the public snapshot together with sources and citations', async () => {
    mocks.researchFindUnique.mockResolvedValue(publishedAiResearch());

    const response = await forkPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/fork`, { method: 'POST' }) as never,
      params(RESEARCH_ID),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      id: REVISION_ID,
      status: 'draft',
      supersedesResearchId: RESEARCH_ID,
    });
    expect(mocks.researchCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'draft',
        creationMethod: 'ai_research',
        aiAssisted: false,
        supersedesResearchId: RESEARCH_ID,
        researchSources: {
          create: [expect.objectContaining({
            canonicalKey: 'https://example.com/docs',
          })],
        },
      }),
    }));
    expect(mocks.researchCitationCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ researchId: REVISION_ID, sourceId: 'source-copy-1', marker: '[^1]' })],
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ researchId: REVISION_ID, action: 'create' }),
    }));
  });

  it('does not fork a draft or private record', async () => {
    mocks.researchFindUnique.mockResolvedValue({ ...publishedAiResearch(), status: 'draft' });
    const response = await forkPost(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}/fork`, { method: 'POST' }) as never,
      params(RESEARCH_ID),
    );
    expect(response.status).toBe(404);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects in-place edits to a published AI snapshot', async () => {
    mocks.researchFindUnique.mockResolvedValue({
      ...publishedAiResearch(),
      sourceAiJob: null,
    });
    const response = await researchPut(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: '被修改的正文' }),
      }) as never,
      params(RESEARCH_ID),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'AI_PUBLISHED_IMMUTABLE' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
