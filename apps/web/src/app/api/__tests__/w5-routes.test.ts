// Unit tests: W5 BFF routes —— /api/radar / /api/radar/[id] / /api/radar-feedback
// / /api/admin/radar / /api/admin/radar/[id]/select|dismiss|retry-interpretation
//
// 测试策略：mock prisma + mock session/auth helpers，覆盖：
//   - 正常路径（list/detail 候选、POST 反馈、select/dismiss/retry）
//   - 无权限路径（admin 端点对 member 返回 403）
//   - 失败路径（zod 校验、404 来源、409 唯一约束、422 sortOrder 冲突）

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  summaryFindMany: vi.fn(),
  summaryFindUnique: vi.fn(),
  summaryFindFirst: vi.fn(),
  summaryCount: vi.fn(),
  summaryUpdate: vi.fn(),
  summaryQueryRaw: vi.fn(),
  summaryGroupBy: vi.fn(),
  radarFeedbackCreate: vi.fn(),
  radarFeedbackFindUnique: vi.fn(),
  radarFeedbackUpsert: vi.fn(),
  radarFeedbackDeleteMany: vi.fn(),
  radarFeedbackGroupBy: vi.fn(),
  radarFeedbackFindMany: vi.fn(),
  userBookmarkUpsert: vi.fn(),
  userBookmarkDeleteMany: vi.fn(),
  adminActionCreate: vi.fn(),
  researchCreate: vi.fn(),
  researchSourceCreate: vi.fn(),
  transaction: vi.fn(),
  randomUUID: vi.fn(),
  fetch: vi.fn(),
  getWebEnv: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));

vi.mock('../../../lib/auth/session.js', () => ({
  getCurrentUser: mocks.getCurrentUser,
  requireUser: mocks.requireUser,
  requireAdmin: mocks.requireAdmin,
}));

vi.mock('../../../lib/env.js', () => ({
  getWebEnv: mocks.getWebEnv,
}));

vi.mock('../../../lib/db.js', () => ({
  prisma: {
    summary: {
      findMany: mocks.summaryFindMany,
      findUnique: mocks.summaryFindUnique,
      findFirst: mocks.summaryFindFirst,
      count: mocks.summaryCount,
      update: mocks.summaryUpdate,
      $queryRaw: mocks.summaryQueryRaw,
      groupBy: mocks.summaryGroupBy,
    },
    radarFeedback: {
      create: mocks.radarFeedbackCreate,
      findUnique: mocks.radarFeedbackFindUnique,
      upsert: mocks.radarFeedbackUpsert,
      deleteMany: mocks.radarFeedbackDeleteMany,
      groupBy: mocks.radarFeedbackGroupBy,
      findMany: mocks.radarFeedbackFindMany,
    },
    userBookmark: {
      upsert: mocks.userBookmarkUpsert,
      deleteMany: mocks.userBookmarkDeleteMany,
    },
    adminAction: { create: mocks.adminActionCreate },
    research: { create: mocks.researchCreate },
    researchSource: { create: mocks.researchSourceCreate },
    $transaction: mocks.transaction,
    $queryRaw: mocks.summaryQueryRaw,
  },
}));

vi.mock('node:crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  randomUUID: mocks.randomUUID,
}));

import { GET as radarList } from '../radar/route';
import { GET as radarDetail } from '../radar/[id]/route';
import { POST as feedbackPost, DELETE as feedbackDelete } from '../radar-feedback/route';
import { GET as adminRadarList } from '../admin/radar/route';
import { POST as adminSelect } from '../admin/radar/[id]/select/route';
import { POST as adminDismiss } from '../admin/radar/[id]/dismiss/route';
import { POST as adminCreateResearch } from '../admin/radar/[id]/create-research/route';
import { POST as adminRetry } from '../admin/radar/[id]/retry-interpretation/route';
import { POST as adminRadarSync } from '../admin/radar/sync/route';
import { POST as adminDigestRegenerate } from '../admin/radar/digest/route';

const MEMBER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'm@x.com',
  name: 'M',
  image: null,
  role: 'member' as const,
  disabledAt: null,
};
const ADMIN = {
  ...MEMBER,
  id: '22222222-2222-2222-2222-222222222222',
  email: 'a@x.com',
  role: 'admin' as const,
};
const SUM_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUser.mockResolvedValue(MEMBER);
  mocks.requireUser.mockResolvedValue(MEMBER);
  mocks.requireAdmin.mockResolvedValue(ADMIN);
  mocks.transaction.mockImplementation((cb) => cb({
    summary: { update: mocks.summaryUpdate },
    radarFeedback: {
      create: mocks.radarFeedbackCreate,
      upsert: mocks.radarFeedbackUpsert,
      deleteMany: mocks.radarFeedbackDeleteMany,
    },
    userBookmark: {
      upsert: mocks.userBookmarkUpsert,
      deleteMany: mocks.userBookmarkDeleteMany,
    },
    adminAction: { create: mocks.adminActionCreate },
    research: { create: mocks.researchCreate },
    researchSource: { create: mocks.researchSourceCreate },
  }));
  mocks.summaryUpdate.mockImplementation(({ data }) => Promise.resolve({
    id: SUM_ID, status: data.status, summaryDate: new Date('2026-07-21'),
    publishedAt: null,
    sortOrder: 0,
    syncRunId: 'r',
  }));
  // 清除 findMany 的特殊 mock —— 每个 test 从 clean slate 开始
  mocks.summaryFindMany.mockReset();
  mocks.adminActionCreate.mockResolvedValue({ id: 'action-1', requestId: 'req-1' });
  mocks.researchCreate.mockResolvedValue({
    id: 'research-1', type: 'research', status: 'draft',
    title: 'X', creationMethod: 'ai_research', authorId: ADMIN.id,
    createdAt: new Date(),
  });
  mocks.researchSourceCreate.mockResolvedValue({ id: 'rs-1' });
  mocks.radarFeedbackCreate.mockResolvedValue({ id: 'fb-1' });
  mocks.radarFeedbackFindUnique.mockResolvedValue(null);
  mocks.radarFeedbackUpsert.mockResolvedValue({ id: 'fb-1' });
  mocks.radarFeedbackDeleteMany.mockResolvedValue({ count: 1 });
  mocks.userBookmarkUpsert.mockResolvedValue({ id: 'bookmark-1' });
  mocks.userBookmarkDeleteMany.mockResolvedValue({ count: 1 });
  mocks.randomUUID.mockReturnValue('00000000-0000-4000-8000-000000000001');
  mocks.getWebEnv.mockReturnValue({ AI_ENGINE_URL: 'http://localhost:4000' });
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockImplementation(() => Promise.resolve(new Response(
    JSON.stringify({ runId: 'run-1', status: 'queued', requestId: 'req-1' }),
    { status: 202, headers: { 'content-type': 'application/json' } },
  )));
});

describe('POST /api/admin/radar actions', () => {
  it('rejects member sync requests', async () => {
    const { NextResponse } = await import('next/server');
    mocks.requireAdmin.mockResolvedValueOnce(NextResponse.json(
      { code: 'PERMISSION_DENIED', message: '需要管理员权限', requestId: 'r' },
      { status: 403 },
    ));

    const response = await adminRadarSync(
      new Request('http://localhost/api/admin/radar/sync', { method: 'POST' }) as never,
    );

    expect(response.status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('forwards admin sync and digest regeneration independently', async () => {
    const syncResponse = await adminRadarSync(
      new Request('http://localhost/api/admin/radar/sync', { method: 'POST' }) as never,
    );
    const digestResponse = await adminDigestRegenerate(
      new Request('http://localhost/api/admin/radar/digest', { method: 'POST' }) as never,
    );

    expect(syncResponse.status).toBe(202);
    expect(digestResponse.status).toBe(202);
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      1,
      'http://localhost:4000/api/radar/sync',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ triggeredBy: 'admin' }),
      }),
    );
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      2,
      'http://localhost:4000/api/radar/digest/regenerate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// /api/radar
// ──────────────────────────────────────────────────────────────────────

describe('GET /api/radar', () => {
  it('returns public candidates when no user session exists', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    mocks.summaryFindMany.mockResolvedValue([]);
    mocks.summaryCount.mockResolvedValue(0);
    const r = await radarList(new Request('http://localhost/api/radar') as never);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ items: [], total: 0 });
  });

  it('returns 400 on invalid query params', async () => {
    const r = await radarList(
      new Request('http://localhost/api/radar?per_page=999') as never,
    );
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('VALIDATION_FAILED');
  });

  it('returns empty list when no candidates', async () => {
    mocks.summaryFindMany.mockResolvedValue([]);
    mocks.summaryCount.mockResolvedValue(0);
    const r = await radarList(new Request('http://localhost/api/radar') as never);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('maps grouped radar categories to source filters', async () => {
    mocks.summaryFindMany.mockResolvedValue([]);
    mocks.summaryCount.mockResolvedValue(0);

    await radarList(new Request('http://localhost/api/radar?sourceType=articles') as never);
    expect(mocks.summaryFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                syncRun: { source: { sourceType: { in: ['rss', 'devto', 'vendor_news', 'wechat', 'sitemap_watch'] } } },
              }),
            ]),
          }),
        ]),
      }),
    }));

    await radarList(new Request('http://localhost/api/radar?sourceType=community') as never);
    expect(mocks.summaryFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                syncRun: { source: { sourceType: { in: ['hackernews', 'producthunt', 'reddit', 'lobsters'] } } },
              }),
            ]),
          }),
        ]),
      }),
    }));
  });

  it('returns shaped candidates with feedback counts', async () => {
    mocks.summaryFindMany.mockResolvedValue([{
      id: SUM_ID,
      title: 'RAG strategies',
      body: 'body',
      url: 'https://example.com/a',
      tags: ['rag'],
      status: 'candidate',
      summaryDate: new Date('2026-07-21'),
      publishedAt: null,
      createdAt: new Date('2026-07-21T08:00:00Z'),
      interpretation: 'covers RAG',
      scoreReason: 'high relevance',
      scoreVersion: 'v1',
      relevanceScore: 0.91,
      timelinessScore: 0.83,
      sourceQualityScore: 0.76,
      selectionReason: null,
      sortOrder: null,
      syncRunId: 'run-1',
      sharedBy: null,
      syncRun: { id: 'run-1', completedAt: new Date('2026-07-21T07:00:00Z'), source: { sourceType: 'github', name: 'GH' } },
    }]);
    mocks.summaryCount.mockResolvedValue(1);
    mocks.radarFeedbackGroupBy.mockResolvedValue([
      { summaryId: SUM_ID, feedbackType: 'useful', _count: { feedbackType: 2 } },
    ]);
    mocks.radarFeedbackFindMany.mockResolvedValue([
      { summaryId: SUM_ID, feedbackType: 'useful' },
    ]);
    const r = await radarList(new Request('http://localhost/api/radar') as never);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    const it0 = body.items[0];
    expect(it0.title).toBe('RAG strategies');
    expect(it0.interpretation).toBe('covers RAG');
    expect(it0.sourceType).toBe('github');
    expect(it0.feedbackCounts.useful).toBe(2);
    expect(it0.myFeedbacks).toEqual(['useful']);
    expect(it0.relevanceScore).toBe(0.91);
  });

  it('filters out non-matching q on app side (postgres OR gaps)', async () => {
    // 数据库粗筛可能返回额外记录；应用层 matchesQuery 负责最终过滤。
    mocks.summaryFindMany.mockImplementation(() => {
          const all = [
            { id: SUM_ID, title: 'A', body: 'a', url: 'u', tags: [], status: 'candidate',
              summaryDate: new Date(), publishedAt: null, createdAt: new Date(),
              interpretation: null, scoreReason: null, scoreVersion: null,
              relevanceScore: null, timelinessScore: null, sourceQualityScore: null,
              selectionReason: null, sortOrder: null, syncRunId: 'r',
              sharedBy: null,
              syncRun: { id: 'r', completedAt: null, source: { sourceType: 'rss', name: 'X' } } },
            { id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', title: 'B', body: 'b', url: 'u',
              tags: [], status: 'candidate', summaryDate: new Date(), publishedAt: null,
              createdAt: new Date(), interpretation: null, scoreReason: null,
              scoreVersion: null, relevanceScore: null, timelinessScore: null,
              sourceQualityScore: null, selectionReason: null, sortOrder: null,
              syncRunId: 'r', sharedBy: null,
              syncRun: { id: 'r', completedAt: null, source: { sourceType: 'rss', name: 'X' } } },
          ];
          return Promise.resolve(all);
        },
    );
    mocks.summaryCount.mockResolvedValue(2);
    const r = await radarList(new Request('http://localhost/api/radar?q=A') as never);
    const body = await r.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe('A');
  });
});

// ──────────────────────────────────────────────────────────────────────
// /api/radar/[id]
// ──────────────────────────────────────────────────────────────────────

describe('GET /api/radar/[id]', () => {
  it('returns 400 on bad uuid', async () => {
    const r = await radarDetail(
      new Request('http://localhost/api/radar/xxx') as never,
      { params: Promise.resolve({ id: 'xxx' }) },
    );
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('VALIDATION_FAILED');
  });

  it('returns 404 for an unapproved user summary', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, title: 'A', body: 'a', url: 'u', tags: [], status: 'published',
      summaryDate: new Date(), publishedAt: null, createdAt: new Date(),
      interpretation: null, scoreReason: null, scoreVersion: null,
      relevanceScore: null, timelinessScore: null, sourceQualityScore: null,
      selectionReason: null, sortOrder: null, syncRunId: null, source: 'user',
      sharedBy: null, syncRun: null, shareSource: null,
    });
    const r = await radarDetail(
      new Request('http://localhost/api/radar/x') as never,
      { params: Promise.resolve({ id: SUM_ID }) },
    );
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe('DRAFT_NOT_FOUND');
  });

  it('returns an approved user share as a radar candidate', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, title: 'Shared article', body: 'reviewed body', url: 'https://example.com',
      tags: [], status: 'candidate', summaryDate: new Date('2026-08-04'),
      publishedAt: null, createdAt: new Date(), interpretation: null,
      scoreReason: null, scoreVersion: null, relevanceScore: null,
      timelinessScore: null, sourceQualityScore: null, selectionReason: null,
      sortOrder: null, syncRunId: null, source: 'user', sharedBy: { id: MEMBER.id, name: 'M' },
      syncRun: null, shareSource: { status: 'approved' },
    });
    mocks.radarFeedbackGroupBy.mockResolvedValue([]);
    mocks.radarFeedbackFindMany.mockResolvedValue([]);

    const response = await radarDetail(
      new Request('http://localhost/api/radar/x') as never,
      { params: Promise.resolve({ id: SUM_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.title).toBe('Shared article');
    expect(body.sourceType).toBe('web_share');
  });

  it('returns detail with body for radar candidate', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, title: 'A', body: 'long body', url: 'u', tags: ['rag'],
      status: 'candidate', summaryDate: new Date('2026-07-21'),
      publishedAt: null, createdAt: new Date(),
      interpretation: 'cover', scoreReason: 'high', scoreVersion: 'v1',
      relevanceScore: 0.9, timelinessScore: 0.8, sourceQualityScore: 0.7,
      selectionReason: null, sortOrder: null, syncRunId: 'r',
      source: 'daily', sharedBy: null,
      syncRun: { id: 'r', completedAt: new Date(), source: { sourceType: 'arxiv', name: 'arXiv' } },
    });
    mocks.radarFeedbackGroupBy.mockResolvedValue([]);
    mocks.radarFeedbackFindMany.mockResolvedValue([]);
    const r = await radarDetail(
      new Request('http://localhost/api/radar/x') as never,
      { params: Promise.resolve({ id: SUM_ID }) },
    );
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.body).toBe('long body');
    expect(body.canManage).toBe(false); // MEMBER role
    expect(body.sourceType).toBe('arxiv');
  });

  it('canManage=true for admin caller', async () => {
    mocks.requireUser.mockResolvedValueOnce(ADMIN);
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, title: 'A', body: 'a', url: 'u', tags: [], status: 'candidate',
      summaryDate: new Date(), publishedAt: null, createdAt: new Date(),
      interpretation: null, scoreReason: null, scoreVersion: null,
      relevanceScore: null, timelinessScore: null, sourceQualityScore: null,
      selectionReason: null, sortOrder: null, syncRunId: 'r',
      source: 'daily', sharedBy: null,
      syncRun: { id: 'r', completedAt: null, source: { sourceType: 'rss', name: 'R' } },
    });
    mocks.radarFeedbackGroupBy.mockResolvedValue([]);
    mocks.radarFeedbackFindMany.mockResolvedValue([]);
    const r = await radarDetail(
      new Request('http://localhost/api/radar/x') as never,
      { params: Promise.resolve({ id: SUM_ID }) },
    );
    const body = await r.json();
    expect(body.canManage).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// /api/radar-feedback
// ──────────────────────────────────────────────────────────────────────

describe('POST /api/radar-feedback', () => {
  it('returns 400 on bad body', async () => {
    const req = new Request('http://localhost/api/radar-feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryId: 'xxx', feedbackType: 'useful' }),
    });
    const r = await feedbackPost(req as never);
    expect(r.status).toBe(400);
  });

  it('returns 404 when summary is not a radar candidate', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, source: 'user', syncRunId: null,
    });
    const req = new Request('http://localhost/api/radar-feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryId: SUM_ID, feedbackType: 'useful' }),
    });
    const r = await feedbackPost(req as never);
    expect(r.status).toBe(404);
  });

  it('returns 200 + created=true when feedback inserted', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, source: 'daily', syncRunId: 'r',
    });
    mocks.radarFeedbackGroupBy.mockResolvedValue([]);
    const req = new Request('http://localhost/api/radar-feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryId: SUM_ID, feedbackType: 'useful' }),
    });
    const r = await feedbackPost(req as never);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
  });

  it('treats P2002 as idempotent (created=false)', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, source: 'daily', syncRunId: 'r',
    });
    mocks.radarFeedbackCreate.mockRejectedValue({ code: 'P2002' });
    mocks.radarFeedbackGroupBy.mockResolvedValue([]);
    const req = new Request('http://localhost/api/radar-feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryId: SUM_ID, feedbackType: 'useful' }),
    });
    const r = await feedbackPost(req as never);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.created).toBe(false);
  });

  it('mirrors favorite feedback into user bookmarks atomically', async () => {
    mocks.summaryFindUnique.mockResolvedValue({ id: SUM_ID, source: 'daily', syncRunId: 'r' });
    mocks.radarFeedbackGroupBy.mockResolvedValue([
      { feedbackType: 'favorite', _count: { feedbackType: 1 } },
    ]);
    const req = new Request('http://localhost/api/radar-feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryId: SUM_ID, feedbackType: 'favorite' }),
    });

    const response = await feedbackPost(req as never);

    expect(response.status).toBe(200);
    expect(mocks.radarFeedbackUpsert).toHaveBeenCalledOnce();
    expect(mocks.userBookmarkUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        userId: MEMBER.id,
        targetType: 'radar_candidate',
        targetId: SUM_ID,
      }),
    }));
  });
});

describe('DELETE /api/radar-feedback', () => {
  it('returns 400 on missing params', async () => {
    const r = await feedbackDelete(
      new Request('http://localhost/api/radar-feedback') as never,
    );
    expect(r.status).toBe(400);
  });

  it('returns 200 + removed=N', async () => {
    mocks.radarFeedbackDeleteMany.mockResolvedValue({ count: 1 });
    mocks.radarFeedbackGroupBy.mockResolvedValue([]);
    const r = await feedbackDelete(
      new Request(
        `http://localhost/api/radar-feedback?summaryId=${SUM_ID}&feedbackType=useful`,
      ) as never,
    );
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.removed).toBe(1);
  });

  it('removes favorite feedback and bookmark in one transaction', async () => {
    mocks.radarFeedbackGroupBy.mockResolvedValue([]);
    const response = await feedbackDelete(
      new Request(
        `http://localhost/api/radar-feedback?summaryId=${SUM_ID}&feedbackType=favorite`,
      ) as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.radarFeedbackDeleteMany).toHaveBeenCalledOnce();
    expect(mocks.userBookmarkDeleteMany).toHaveBeenCalledWith({
      where: { userId: MEMBER.id, targetType: 'radar_candidate', targetId: SUM_ID },
    });
  });

  it('returns 200 + removed=0 when no row matched', async () => {
    mocks.radarFeedbackDeleteMany.mockResolvedValue({ count: 0 });
    mocks.radarFeedbackGroupBy.mockResolvedValue([]);
    const r = await feedbackDelete(
      new Request(
        `http://localhost/api/radar-feedback?summaryId=${SUM_ID}&feedbackType=useful`,
      ) as never,
    );
    const body = await r.json();
    expect(body.removed).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// /api/admin/radar
// ──────────────────────────────────────────────────────────────────────

describe('GET /api/admin/radar', () => {
  it('returns 403 for member', async () => {
    const { NextResponse } = await import('next/server');
    mocks.requireAdmin.mockResolvedValueOnce(NextResponse.json(
      { code: 'PERMISSION_DENIED', message: '需要管理员权限', requestId: 'r' },
      { status: 403 },
    ));
    const r = await adminRadarList(new Request('http://localhost/api/admin/radar') as never);
    expect(r.status).toBe(403);
  });

  it('returns admin list with shape', async () => {
    mocks.summaryFindMany.mockResolvedValue([]);
    mocks.summaryCount.mockResolvedValue(0);
    const r = await adminRadarList(new Request('http://localhost/api/admin/radar') as never);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it('keeps the radar visibility boundary when searching', async () => {
    mocks.summaryFindMany.mockResolvedValue([]);
    mocks.summaryCount.mockResolvedValue(0);

    await adminRadarList(new Request('http://localhost/api/admin/radar?q=vector') as never);

    expect(mocks.summaryFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          expect.objectContaining({
            OR: expect.arrayContaining([
              { source: 'daily', syncRunId: { not: null } },
              { source: 'user', shareSource: { is: { status: 'approved' } } },
            ]),
          }),
          expect.objectContaining({
            OR: expect.arrayContaining([
              { title: { contains: 'vector', mode: 'insensitive' } },
            ]),
          }),
        ]),
      }),
    }));
  });

  it('filters grouped sources and approved web shares in the database query', async () => {
    mocks.summaryFindMany.mockResolvedValue([]);
    mocks.summaryCount.mockResolvedValue(0);

    await adminRadarList(new Request('http://localhost/api/admin/radar?sourceType=community') as never);
    expect(mocks.summaryFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          expect.objectContaining({
            OR: [expect.objectContaining({
              syncRun: { source: { sourceType: { in: ['hackernews', 'producthunt', 'reddit', 'lobsters'] } } },
            })],
          }),
        ]),
      }),
    }));

    await adminRadarList(new Request('http://localhost/api/admin/radar?sourceType=web_share') as never);
    expect(mocks.summaryFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          { OR: [{ source: 'user', shareSource: { is: { status: 'approved' } } }] },
        ]),
      }),
    }));
  });
});

// ──────────────────────────────────────────────────────────────────────
// /api/admin/radar/[id]/select
// ──────────────────────────────────────────────────────────────────────

describe('POST /api/admin/radar/[id]/select', () => {
  it('returns 403 for member', async () => {
    const { NextResponse } = await import('next/server');
    mocks.requireAdmin.mockResolvedValueOnce(NextResponse.json(
      { code: 'PERMISSION_DENIED', message: '需要管理员权限', requestId: 'r' },
      { status: 403 },
    ));
    const req = new Request('http://localhost/x', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryDate: '2026-07-21', sortOrder: 1, selectionReason: 'r' }),
    });
    const r = await adminSelect(req as never, { params: Promise.resolve({ id: SUM_ID }) });
    expect(r.status).toBe(403);
  });

  it('returns 400 on bad sortOrder', async () => {
    const req = new Request('http://localhost/x', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryDate: '2026-07-21', sortOrder: 99, selectionReason: 'r' }),
    });
    const r = await adminSelect(req as never, { params: Promise.resolve({ id: SUM_ID }) });
    expect(r.status).toBe(400);
  });

  it('returns 404 when summary is not radar', async () => {
    mocks.summaryFindUnique.mockResolvedValue({ id: SUM_ID, source: 'user', syncRunId: null, status: 'candidate' });
    const req = new Request('http://localhost/x', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryDate: '2026-07-21', sortOrder: 1, selectionReason: 'reason' }),
    });
    const r = await adminSelect(req as never, { params: Promise.resolve({ id: SUM_ID }) });
    expect(r.status).toBe(404);
  });

  it('returns 400 when sortOrder slot is taken', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, source: 'daily', syncRunId: 'r', status: 'candidate',
      summaryDate: new Date('2026-07-21'), sortOrder: 1,
    });
    mocks.summaryFindFirst.mockResolvedValue({ id: 'cccc' });
    const req = new Request('http://localhost/x', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryDate: '2026-07-21', sortOrder: 1, selectionReason: 'r' }),
    });
    const r = await adminSelect(req as never, { params: Promise.resolve({ id: SUM_ID }) });
    expect(r.status).toBe(400);
  });

  it('returns 400 when 4 already published on that date', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, source: 'daily', syncRunId: 'r', status: 'candidate',
      summaryDate: new Date('2026-07-21'), sortOrder: null,
    });
    mocks.summaryFindFirst.mockResolvedValue(null);
    mocks.summaryCount.mockResolvedValue(4);
    const req = new Request('http://localhost/x', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryDate: '2026-07-21', sortOrder: 1, selectionReason: 'r' }),
    });
    const r = await adminSelect(req as never, { params: Promise.resolve({ id: SUM_ID }) });
    expect(r.status).toBe(400);
  });

  it('updates summary and writes admin_action on success', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, source: 'daily', syncRunId: 'r', status: 'candidate',
      summaryDate: new Date('2026-07-21'), sortOrder: null,
    });
    mocks.summaryFindFirst.mockResolvedValue(null);
    mocks.summaryCount.mockResolvedValue(0);
    const req = new Request('http://localhost/x', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryDate: '2026-07-21', sortOrder: 1, selectionReason: 'reason here' }),
    });
    const r = await adminSelect(req as never, { params: Promise.resolve({ id: SUM_ID }) });
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.actionRequestId).toBeTruthy();
    expect(mocks.summaryUpdate).toHaveBeenCalled();
    expect(mocks.adminActionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'radar_select', targetId: SUM_ID }),
    }));
  });

  it('allows an approved user share to be selected', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, source: 'user', syncRunId: null, status: 'candidate',
      summaryDate: new Date('2026-07-21'), sortOrder: null,
      shareSource: { status: 'approved' },
    });
    mocks.summaryFindFirst.mockResolvedValue(null);
    mocks.summaryCount.mockResolvedValue(0);
    const response = await adminSelect(new Request('http://localhost/x', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryDate: '2026-07-21', sortOrder: 1, selectionReason: 'reviewed' }),
    }) as never, { params: Promise.resolve({ id: SUM_ID }) });

    expect(response.status).toBe(200);
    expect(mocks.summaryUpdate).toHaveBeenCalledOnce();
  });
});

// ──────────────────────────────────────────────────────────────────────
// /api/admin/radar/[id]/dismiss
// ──────────────────────────────────────────────────────────────────────

describe('POST /api/admin/radar/[id]/dismiss', () => {
  it('returns 404 when summary not radar', async () => {
    mocks.summaryFindUnique.mockResolvedValue({ id: SUM_ID, source: 'user', syncRunId: null, status: 'candidate' });
    const r = await adminDismiss(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: SUM_ID }) },
    );
    expect(r.status).toBe(404);
  });

  it('updates status to rejected and writes admin_action', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, source: 'daily', syncRunId: 'r', status: 'candidate',
    });
    mocks.summaryUpdate.mockResolvedValue({
      id: SUM_ID, status: 'rejected', updatedAt: new Date(),
    });
    const r = await adminDismiss(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: SUM_ID }) },
    );
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.summary.status).toBe('rejected');
    expect(mocks.adminActionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'radar_dismiss' }),
    }));
  });

  it('allows an approved user share to be dismissed', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, source: 'user', syncRunId: null, status: 'candidate',
      shareSource: { status: 'approved' },
    });
    mocks.summaryUpdate.mockResolvedValue({ id: SUM_ID, status: 'rejected', updatedAt: new Date() });

    const response = await adminDismiss(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: SUM_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.summaryUpdate).toHaveBeenCalledOnce();
  });
});

describe('POST /api/admin/radar/[id]/create-research', () => {
  const approvedShare = {
    id: SUM_ID,
    title: 'Reviewed share',
    body: 'Useful source',
    url: 'https://example.com/reviewed',
    source: 'user',
    syncRunId: null,
    tags: ['reviewed'],
    interpretation: 'Worth researching',
    shareSource: { status: 'approved' },
  };

  it('returns 404 for an unapproved user summary', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      ...approvedShare,
      shareSource: { status: 'pending' },
    });

    const response = await adminCreateResearch(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: SUM_ID }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.researchCreate).not.toHaveBeenCalled();
  });

  it('creates a draft from an approved user share', async () => {
    mocks.summaryFindUnique.mockResolvedValue(approvedShare);

    const response = await adminCreateResearch(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: SUM_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.research.id).toBe('research-1');
    expect(mocks.researchCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ title: 'Reviewed share', authorId: ADMIN.id }),
    }));
    expect(mocks.researchSourceCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ canonicalKey: 'https://example.com/reviewed' }),
    }));
    expect(mocks.adminActionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'radar_create_research', targetId: SUM_ID }),
    }));
  });
});

// ──────────────────────────────────────────────────────────────────────
// /api/admin/radar/[id]/retry-interpretation
// ──────────────────────────────────────────────────────────────────────

describe('POST /api/admin/radar/[id]/retry-interpretation', () => {
  it('returns 404 when summary not radar', async () => {
    mocks.summaryFindUnique.mockResolvedValue({ id: SUM_ID, source: 'user', syncRunId: null, status: 'candidate' });
    const r = await adminRetry(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: SUM_ID }) },
    );
    expect(r.status).toBe(404);
  });

  it('resets interpretation and writes admin_action', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, source: 'daily', syncRunId: 'r', status: 'interpreted',
      syncRun: { id: 'r' },
    });
    mocks.summaryUpdate.mockResolvedValue({
      id: SUM_ID, status: 'candidate', interpretation: null, updatedAt: new Date(),
    });
    const r = await adminRetry(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: SUM_ID }) },
    );
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.summary.interpretation).toBeNull();
    expect(mocks.summaryUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'candidate', interpretation: null,
        relevanceScore: null, timelinessScore: null, sourceQualityScore: null,
      }),
    }));
    expect(mocks.adminActionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'radar_retry_interpretation' }),
    }));
  });
});
