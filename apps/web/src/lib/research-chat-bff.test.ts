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



it('uses current draft sources, upgrades matching full evidence, and never revives deleted or changed sources', async () => {
  const date = new Date('2026-09-04T00:00:00Z');
  const key = 'https://example.com/docs'; const ref = { type: 'url', value: key };
  const body = 'Relevant context. '.repeat(400) + ' ExceptionGroup and CancelledError differ; return_exceptions=False.';
  const oldKey = 'https://example.com/deleted'; const oldRef = { type: 'url', value: oldKey };
  const changedKey = 'https://example.com/changed'; const changedRef = { type: 'url', value: changedKey };
  const partialSources = [
    { canonical_key: key, source_ref: ref, title: 'Docs', snippet: body },
    { canonical_key: oldKey, source_ref: oldRef, title: 'Deleted', snippet: 'Deleted old evidence' },
    { canonical_key: changedKey, source_ref: changedRef, title: 'Changed', snippet: 'Stale original evidence' },
  ];
  mocks.jobFindUnique.mockResolvedValue({ id: 'job', topic: 'Asyncio', outputText: '', draftResearchId: 'draft', requesterId: 'user', partialSources,
    aiResearchSources: [{ canonicalKey: oldKey, sourceRef: oldRef, title: 'Deleted', snippet: 'Deleted old evidence', createdAt: date }] });
  mocks.researchFindUnique.mockResolvedValue({ body: '# 报告\n\n[删除的来源](https://example.com/deleted)', researchSources: [
    { canonicalKey: key, sourceRef: ref, title: 'Docs', description: Array.from(body).slice(0, 999).join('').trimEnd() + '…', createdAt: date },
    { canonicalKey: changedKey, sourceRef: changedRef, title: 'Changed', description: 'Updated evidence', createdAt: date },
  ] });
  const result = await loadResearchReportForJob('job', 'req');
  expect(result?.evidence.map((item) => item.key)).toEqual([key, changedKey]);
  expect(result?.evidence[0].excerpt).toContain('ExceptionGroup and CancelledError');
  expect(result?.evidence[0].excerpt).toContain('return_exceptions=False');
  expect(result?.evidence[1].excerpt).toBe('Updated evidence');
  expect(result?.content).not.toContain('](https://example.com/deleted)');
});

it('upgrades a matching 2000-character job preview when no draft exists', async () => {
  const key = 'https://example.com/docs'; const ref = { type: 'url', value: key };
  const body = 'Original text. '.repeat(350) + 'Late evidence marker';
  mocks.jobFindUnique.mockResolvedValue({ id: 'job', topic: 'Topic', outputText: 'Report', draftResearchId: null, requesterId: 'user',
    partialSources: [{ canonical_key: key, source_ref: ref, title: 'Docs', snippet: body }],
    aiResearchSources: [{ canonicalKey: key, sourceRef: ref, title: 'Docs', snippet: Array.from(body).slice(0, 1999).join('').trimEnd() + '…', createdAt: new Date() }] });
  const result = await loadResearchReportForJob('job', 'req');
  expect(result?.evidence[0].excerpt).toContain('Late evidence marker');
});

it('fairly limits total follow-up evidence to 120000 characters', async () => {
  const sources = Array.from({ length: 32 }, (_, i) => ({ canonicalKey: `https://example.com/${i}`, sourceRef: { type: 'url', value: `https://example.com/${i}` }, title: `Doc ${i}`, description: 'X'.repeat(12000), createdAt: new Date() }));
  mocks.jobFindUnique.mockResolvedValue({ id: 'job', topic: 'Topic', outputText: '', draftResearchId: 'draft', requesterId: 'user', partialSources: [], aiResearchSources: [] });
  mocks.researchFindUnique.mockResolvedValue({ body: 'Report', researchSources: sources });
  const result = await loadResearchReportForJob('job', 'req');
  expect(result?.evidence).toHaveLength(32);
  expect(result?.evidence.map((source) => source.excerpt.length)).toEqual(Array(32).fill(3750));
});
