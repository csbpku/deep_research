import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({ user: vi.fn(), radar: vi.fn(), topics: vi.fn(), research: vi.fn() }));
vi.mock('@/lib/api-handler', () => ({ apiHandler: (fn: unknown) => fn }));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.user }));
vi.mock('@/lib/knowledge-provenance', () => ({ readingRadarOrigin: mocks.radar, knowledgePageUrl: (url: string) => url }));
vi.mock('@/lib/db', () => ({ prisma: {
  topicCandidate: { findMany: mocks.topics }, research: { findMany: mocks.research },
} }));
import { GET } from './route';
const radarId = '11111111-1111-4111-8111-111111111111';
const topicId = '22222222-2222-4222-8222-222222222222';
const request = (query: string) => new Request(`http://localhost/api/knowledge/related?${query}`) as never;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: 'owner' });
  mocks.radar.mockResolvedValue({ id: radarId, url: 'https://example.com/source' });
  mocks.topics.mockResolvedValue([{ topicId }]);
  mocks.research.mockResolvedValue([]);
});

describe('private knowledge resurfacing', () => {
  it('does not query private judgments for anonymous callers', async () => {
    mocks.user.mockResolvedValue(new NextResponse(null, { status: 401 }));
    expect((await GET(request(`topicId=${topicId}`))).status).toBe(401);
    expect(mocks.research).not.toHaveBeenCalled();
  });
  it('does not reveal unavailable radar or permit unconstrained browsing', async () => {
    expect((await GET(request(''))).status).toBe(400);
    mocks.radar.mockResolvedValue(null);
    expect(await (await GET(request(`radarSummaryId=${radarId}`))).json()).toEqual({ items: [] });
    expect(mocks.research).not.toHaveBeenCalled();
  });
  it('queries only the owner, excludes archived and unconfirmed knowledge, and ranks exact source first', async () => {
    const base = { title: '判断', conclusion: '先小规模验证', status: 'draft', updatedAt: new Date('2026-10-20'), knowledgeIndexText: 'confirmed' };
    mocks.research.mockResolvedValue([
      { ...base, id: 'topic-only', researchSources: [] },
      { ...base, id: 'exact', researchSources: [{ sourceRef: { radarSummaryId: radarId } }] },
    ]);
    const response = await GET(request(`radarSummaryId=${radarId}`));
    const { items } = await response.json();
    expect(items[0]).toMatchObject({ id: 'exact', matchReason: '同一来源', private: true });
    expect(items[1]).toMatchObject({ id: 'topic-only', matchReason: '同一专题' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.research.mock.calls[0][0].where).toMatchObject({
      authorId: 'owner', status: { in: ['draft', 'published'] },
      OR: expect.arrayContaining([{ type: 'knowledge', knowledgeIndexText: { not: null } }]),
    });
  });
  it('keeps an older exact-source judgment ahead of newer prefix and topic candidates', async () => {
    const base = { title: '判断', conclusion: '先小规模验证', status: 'draft', updatedAt: new Date('2026-01-01'), knowledgeIndexText: 'confirmed' };
    mocks.research.mockResolvedValueOnce([{
      ...base, id: 'older-exact', researchSources: [{ sourceRef: { radarSummaryId: radarId } }],
    }]).mockResolvedValueOnce(Array.from({ length: 60 }, (_, i) => ({
      ...base, id: `other-page-${i}`, researchSources: [{ sourceRef: {}, canonicalKey: `https://example.com/source?id=${i}` }],
    }))).mockResolvedValueOnce(Array.from({ length: 6 }, (_, i) => ({
      ...base, id: `topic-${i}`, researchSources: [],
    })));
    const { items } = await (await GET(request(`radarSummaryId=${radarId}`))).json();
    expect(items[0]).toMatchObject({ id: 'older-exact', matchReason: '同一来源' });
    expect(items).toHaveLength(3);
    expect(mocks.research.mock.calls[0][0].take).toBe(3);
  });
});
