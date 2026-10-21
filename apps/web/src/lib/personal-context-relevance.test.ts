import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { research: { findMany: mocks.findMany } } }));

import {
  extractPersonalContextKeywords,
  findPersonalContext,
  PERSONAL_CONTEXT_LIMITS,
  personalContextTextScore,
} from './personal-context-relevance';

const USER = '11111111-1111-4111-8111-111111111111';
const TOPIC = '22222222-2222-4222-8222-222222222222';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'research-1', title: 'GraphRAG 索引成本', type: 'research', authorId: USER,
    status: 'draft', body: 'GraphRAG retrieval costs', conclusion: '先验证', background: null,
    knowledgeIndexText: null, updatedAt: new Date('2026-10-19T00:00:00Z'), researchTopics: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findMany.mockResolvedValue([]);
});

describe('personal context keyword relevance', () => {
  it('extracts Chinese and English terms instead of matching a whole question', () => {
    const query = '我们是否应该采用 GraphRAG 来降低向量检索成本？';
    const keywords = extractPersonalContextKeywords(query);
    expect(keywords).toEqual(expect.arrayContaining(['graphrag', '向量', '检索', '成本']));
    expect(keywords).not.toContain(query.toLowerCase());
    expect(keywords).not.toEqual(expect.arrayContaining(['我们', '是否', '应该']));
    expect(personalContextTextScore(keywords, { title: '向量检索成本记录' })).toBeGreaterThan(0);
  });

  it('normalizes mixed-case and full-width names, removes boilerplate and numbers', () => {
    expect(extractPersonalContextKeywords('How should we use ＧｒａｐｈＲＡＧ and PostgreSQL 2026?')).toEqual([
      'graphrag', 'postgresql',
    ]);
    expect(extractPersonalContextKeywords('如何？')).toEqual([]);
  });

  it('bounds query length, token count and token lengths', () => {
    const keywords = extractPersonalContextKeywords(`${'Token '.repeat(1000)} sentinel`);
    expect(keywords).not.toContain('sentinel');
    expect(extractPersonalContextKeywords(Array.from({ length: 100 }, (_, i) => `term${i}`).join(' ')))
      .toHaveLength(PERSONAL_CONTEXT_LIMITS.keywords);
    expect(extractPersonalContextKeywords('a'.repeat(1000))).toEqual([]);
  });

  it('weights titles and confirmed judgments above incidental body mentions', () => {
    expect(personalContextTextScore(['graphrag'], { title: 'GraphRAG' }))
      .toBeGreaterThan(personalContextTextScore(['graphrag'], { body: 'GraphRAG' }));
    expect(personalContextTextScore(['graphrag'], { knowledgeIndexText: 'GraphRAG' }))
      .toBeGreaterThan(personalContextTextScore(['graphrag'], { body: 'GraphRAG' }));
  });

  it('does not query all history for an empty/boilerplate question', async () => {
    expect(await findPersonalContext(USER, '如何？')).toEqual([]);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('ranks own confirmed knowledge, then own research, and uses confirmed text as the snippet', async () => {
    mocks.findMany.mockResolvedValueOnce([row({
      id: 'knowledge-1', type: 'knowledge', knowledgeIndexText: 'GraphRAG 已确认：先小规模验证',
      body: 'Unconfirmed Reader excerpt', updatedAt: new Date('2026-01-01T00:00:00Z'),
    })]).mockResolvedValueOnce([
      row({ id: 'public-1', authorId: 'another-user', status: 'published' }),
      row({ id: 'research-1', status: 'published' }),
      row({ id: 'unconfirmed-1', type: 'knowledge' }),
    ]);
    const results = await findPersonalContext(USER, 'How should we evaluate GraphRAG?', [], true);
    expect(results.map((item) => item.id)).toEqual(['knowledge-1', 'research-1', 'unconfirmed-1', 'public-1']);
    expect(results[0]).toMatchObject({
      confirmedKnowledge: true, private: true, status: 'draft',
      snippet: 'GraphRAG 已确认：先小规模验证',
      sourceRefs: [{ type: 'research', value: 'knowledge-1', required: false }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(JSON.stringify(results)).not.toContain('Unconfirmed Reader excerpt');
  });

  it('matches an explicit topic even when the question has no overlapping title words', async () => {
    mocks.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      row({ title: '之前的架构决策', body: '', researchTopics: [{ topicId: TOPIC }] }),
    ]);
    const results = await findPersonalContext(USER, '新的研究方向', [TOPIC]);
    expect(results[0]).toMatchObject({ id: 'research-1', topicMatch: true });
    expect(mocks.findMany.mock.calls[1][0].where.AND[1].OR).toContainEqual({
      researchTopics: { some: { topicId: { in: [TOPIC] } } },
    });
  });

  it('includes both confirmed private knowledge drafts and published personal knowledge', async () => {
    mocks.findMany.mockResolvedValueOnce([
      row({ id: 'confirmed-draft', type: 'knowledge', knowledgeIndexText: 'GraphRAG 先小规模验证。' }),
      row({ id: 'confirmed-published', type: 'knowledge', status: 'published', knowledgeIndexText: 'GraphRAG 已确认判断。' }),
    ]).mockResolvedValueOnce([
      row({ id: 'published-note', type: 'knowledge', status: 'published' }),
    ]);
    const results = await findPersonalContext(USER, 'GraphRAG');
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'confirmed-draft', confirmedKnowledge: true, private: true, status: 'draft' }),
      expect.objectContaining({ id: 'confirmed-published', confirmedKnowledge: true, private: false, status: 'published' }),
    ]));
    expect(results.some((item) => item.id === 'published-note')).toBe(false);
  });

  it('only offers pure excerpts through manual search and labels them as unconfirmed', async () => {
    mocks.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      row({ id: 'excerpt', type: 'knowledge', status: 'published' }),
    ]);
    expect(await findPersonalContext(USER, 'GraphRAG')).toEqual([]);
    expect(mocks.findMany.mock.calls[1][0].where.type).toEqual({ in: ['research'] });
    mocks.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      row({ id: 'excerpt', type: 'knowledge', status: 'published' }),
    ]);
    expect(await findPersonalContext(USER, 'GraphRAG', [], true)).toEqual([
      expect.objectContaining({ id: 'excerpt', isExcerpt: true, confirmedKnowledge: false }),
    ]);
  });

  it('excludes archived/deleted/foreign private rows even if a candidate read returns them', async () => {
    mocks.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      row({ id: 'archived', status: 'archived' }),
      row({ id: 'deleted', status: 'deleted' }),
      row({ id: 'other-private', authorId: 'another-user' }),
      row({ id: 'other-public', authorId: 'another-user', status: 'published' }),
      row(),
    ]);
    expect((await findPersonalContext(USER, 'GraphRAG')).map((item) => item.id)).toEqual(['research-1']);
    const confirmedQuery = mocks.findMany.mock.calls[0][0];
    expect(confirmedQuery.where).toMatchObject({
      authorId: USER, type: 'knowledge', status: { in: ['draft', 'published'] }, knowledgeIndexText: { not: null },
    });
    expect(confirmedQuery.take).toBe(PERSONAL_CONTEXT_LIMITS.candidates);
    expect(mocks.findMany.mock.calls[1][0].where.AND[0].OR).toEqual([
      { authorId: USER, status: { in: ['draft', 'published'] } },
    ]);
  });

  it('deduplicates candidates and caps results, with deterministic relevance and recency ordering', async () => {
    const records = Array.from({ length: 24 }, (_, i) => row({
      id: `r-${i}`, updatedAt: new Date(Date.UTC(2026, 9, i + 1)),
    }));
    mocks.findMany.mockResolvedValueOnce([records[0]]).mockResolvedValueOnce(records);
    const results = await findPersonalContext(USER, 'GraphRAG');
    expect(results).toHaveLength(PERSONAL_CONTEXT_LIMITS.results);
    expect(new Set(results.map((item) => item.id)).size).toBe(results.length);
    expect(results[0].id).toBe('r-23');
  });
});
