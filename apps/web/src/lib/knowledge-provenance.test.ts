import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ summary: vi.fn(), researches: vi.fn() }));
vi.mock('./db', () => ({ prisma: { summary: { findUnique: mocks.summary }, research: { findMany: mocks.researches } } }));
import { knowledgePageUrl, previousReadingJudgments, readingRadarOrigin, visibleTopicResearch } from './knowledge-provenance';

beforeEach(() => vi.resetAllMocks());

describe('knowledge provenance and private reuse', () => {
  it('normalizes only known hints without merging different document IDs', () => {
    expect(knowledgePageUrl('https://example.com/read?id=1&utm_source=radar&deep-research-summary=x#p'))
      .toBe('https://example.com/read?id=1');
    expect(knowledgePageUrl('https://example.com/read?id=2')).not.toBe(knowledgePageUrl('https://example.com/read?id=1'));
    expect(knowledgePageUrl('https://example.com/?b=2&a=1')).toBe('https://example.com/?a=1&b=2');
    expect(knowledgePageUrl('javascript:alert(1)')).toBeNull();
    expect(knowledgePageUrl('https://secret@example.com/')).toBeNull();
  });

  it('never associates a different page or an unavailable radar item', async () => {
    mocks.summary.mockResolvedValue({
      id: 'radar', url: 'https://example.com/article', source: 'user', status: 'published',
      shareSource: { status: 'approved' }, distilledTier: 'deep_read',
    });
    expect(await readingRadarOrigin('radar', 'https://example.com/article?utm_source=x')).not.toBeNull();
    expect(await readingRadarOrigin('radar', 'https://example.com/other')).toBeNull();
    mocks.summary.mockResolvedValue({ source: 'user', status: 'draft', url: 'https://example.com/article' });
    expect(await readingRadarOrigin('radar')).toBeNull();
  });

  it('public topic reads cannot expose drafts; personal reads add only owned confirmed knowledge', () => {
    expect(visibleTopicResearch()).toEqual({ OR: [{ status: 'published' }] });
    expect(visibleTopicResearch('owner')).toEqual({ OR: [
      { status: 'published' },
      { authorId: 'owner', status: 'draft', type: 'knowledge', knowledgeIndexText: { not: null } },
    ] });
  });

  it('reads only the owner and checks the complete URL after its bounded prefix query', async () => {
    const base = { title: 'My judgment', conclusion: 'Check version compatibility', knowledgeIndexText: 'confirmed', status: 'draft', updatedAt: new Date('2026-10-20') };
    mocks.researches.mockResolvedValue([
      { ...base, id: 'wrong', researchSources: [{ canonicalKey: 'https://example.com/read?id=2', sourceRef: {} }] },
      { ...base, id: 'right', researchSources: [{ canonicalKey: 'https://example.com/read?id=1&utm_source=x', sourceRef: { radarSummaryId: 'radar' } }] },
    ]);
    const items = await previousReadingJudgments('owner', 'https://example.com/read?id=1#p');
    expect(items.map(item => item.id)).toEqual(['right']);
    expect(items[0]?.radarSummaryId).toBe('radar');
    expect(mocks.researches).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        authorId: 'owner', status: { in: ['draft', 'published'] }, knowledgeIndexText: { not: null },
      }), take: 60,
    }));
  });
});
