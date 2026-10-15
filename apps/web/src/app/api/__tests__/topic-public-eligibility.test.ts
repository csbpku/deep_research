import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), query: vi.fn(), candidates: vi.fn(), issues: vi.fn(),
  user: vi.fn(), topic: vi.fn(), trend: vi.fn(),
}));
vi.mock('@/lib/api-handler', () => ({ apiHandler: (handler: unknown) => handler }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mocks.user }));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('@/lib/topics', () => ({
  findTopicBySlugOrId: mocks.topic, loadTopicCandidateTrend: mocks.trend,
  collapseTopicIssues: (issues: unknown) => issues,
}));
vi.mock('@/lib/product-events', () => ({ recordProductEvent: vi.fn() }));

import { GET as detail } from '../topics/[slug]/route';
import { GET as issues } from '../topics/[slug]/issues/route';

const at = new Date('2026-10-15T06:00:00Z');
const context = () => ({ params: Promise.resolve({ slug: 'agents' }) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue(null);
  mocks.topic.mockResolvedValue({ id: 'topic-id', slug: 'agents', aggregationWindowStart: at, aggregationWindowEnd: at });
  mocks.trend.mockResolvedValue([]);
  mocks.transaction.mockImplementation(async fn => fn({
    $queryRaw: mocks.query, topicCandidate: { findMany: mocks.candidates }, topicIssue: { findMany: mocks.issues },
  }));
});

describe('public topic evidence eligibility', () => {
  it('selects eligible links before applying the candidate limit in one snapshot', async () => {
    mocks.query.mockResolvedValue([{ id: 'eligible-link' }]);
    mocks.candidates.mockResolvedValue([{ id: 'eligible-link', addedAt: at, summary: { id: 'valid', createdAt: at } }]);
    const response = await detail(new Request('http://localhost/api/topics/agents') as NextRequest, context());
    const body = await response.json();
    expect(body.candidates.map((row: { id: string }) => row.id)).toEqual(['eligible-link']);
    expect(mocks.candidates).toHaveBeenCalledWith(expect.objectContaining({
      where: { topicId: 'topic-id', id: { in: ['eligible-link'] } }, take: 50,
    }));
    expect(mocks.query.mock.calls[0][0].text).toContain('LIMIT 50');
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead', timeout: 30_000,
    });
  });

  it('does not expose stale links when no topic evidence remains eligible', async () => {
    mocks.query.mockResolvedValue([]);
    mocks.candidates.mockResolvedValue([]);
    const response = await detail(new Request('http://localhost/api/topics/agents') as NextRequest, context());
    expect((await response.json()).candidates).toEqual([]);
    expect(mocks.candidates).toHaveBeenCalledWith(expect.objectContaining({
      where: { topicId: 'topic-id', id: { in: [] } },
    }));
  });

  it('filters issue evidence and suppresses issues with no eligible evidence before counting', async () => {
    mocks.query.mockResolvedValue([{ id: 'valid-summary' }]);
    mocks.issues.mockResolvedValue([
      { id: 'kept', firstSeenAt: at, lastSeenAt: at, candidates: [{ summaryId: 'valid-summary' }] },
      { id: 'stale', firstSeenAt: at, lastSeenAt: at, candidates: [] },
    ]);
    const response = await issues(new Request('http://localhost/api/topics/agents/issues') as NextRequest, context());
    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.issues.map((row: { id: string }) => row.id)).toEqual(['kept']);
    expect(body.issues[0].candidates).toEqual([{ summaryId: 'valid-summary' }]);
    expect(mocks.issues).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ candidates: {
        where: { summaryId: { in: ['valid-summary'] } }, select: { summaryId: true },
      } }),
    }));
  });
});
