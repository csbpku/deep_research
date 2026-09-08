import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobFindUnique: vi.fn(),
  researchFindUnique: vi.fn(),
  fetchAiEngine: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    aiResearchJob: { findUnique: mocks.jobFindUnique },
    research: { findUnique: mocks.researchFindUnique },
  },
}));
vi.mock('@/lib/env', () => ({
  getWebEnv: () => ({ AI_ENGINE_URL: 'http://ai-engine.test' }),
}));
vi.mock('@/lib/ai-bff/fetch-ai-engine', () => ({ fetchAiEngine: mocks.fetchAiEngine }));

import { loadResearchReportForJob } from './research-chat-bff';

beforeEach(() => vi.resetAllMocks());

describe('loadResearchReportForJob', () => {
  it('returns a bounded evidence packet separate from the report synthesis', async () => {
    mocks.jobFindUnique.mockResolvedValue({
      id: 'job-1',
      topic: 'GraphRAG 调研',
      outputText: '# 报告\n\n结论',
      draftResearchId: null,
      requesterId: 'user-1',
      partialSources: [],
      aiResearchSources: [{
        sourceRef: { type: 'url', value: 'https://example.com/docs' },
        canonicalKey: 'https://example.com/docs',
        title: '官方文档',
        snippet: '## 原文标题\n\n**GraphRAG** 适合跨文档关系查询。',
        createdAt: new Date('2026-09-04T00:00:00.000Z'),
      }],
    });

    const result = await loadResearchReportForJob('job-1', 'request-1');

    expect(result).toMatchObject({ title: 'GraphRAG 调研', content: '# 报告\n\n结论' });
    expect(result?.evidence).toEqual([{
      key: 'https://example.com/docs',
      title: '官方文档',
      url: 'https://example.com/docs',
      excerpt: '原文标题 GraphRAG 适合跨文档关系查询。',
      capturedAt: '2026-09-04T00:00:00.000Z',
      sourceType: 'url',
    }]);
  });

  it('does not create evidence from a source that has no captured excerpt', async () => {
    mocks.jobFindUnique.mockResolvedValue({
      id: 'job-2',
      topic: '无正文',
      outputText: '报告',
      draftResearchId: null,
      requesterId: 'user-1',
      partialSources: [],
      aiResearchSources: [{
        sourceRef: { type: 'url', value: 'https://example.com/blocked' },
        canonicalKey: 'https://example.com/blocked',
        title: '被拦截页面',
        snippet: ' ',
        createdAt: new Date('2026-09-04T00:00:00.000Z'),
      }],
    });

    const result = await loadResearchReportForJob('job-2', 'request-1');

    expect(result?.evidence).toEqual([]);
  });
});

