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
  radarFeedbackCreate: vi.fn(),
  radarFeedbackDeleteMany: vi.fn(),
  radarFeedbackGroupBy: vi.fn(),
  radarFeedbackFindMany: vi.fn(),
  adminActionCreate: vi.fn(),
  researchCreate: vi.fn(),
  researchSourceCreate: vi.fn(),
  transaction: vi.fn(),
  randomUUID: vi.fn(),
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

vi.mock('../../../lib/db.js', () => ({
  prisma: {
    summary: {
      findMany: mocks.summaryFindMany,
      findUnique: mocks.summaryFindUnique,
      findFirst: mocks.summaryFindFirst,
      count: mocks.summaryCount,
      update: mocks.summaryUpdate,
    },
    radarFeedback: {
      create: mocks.radarFeedbackCreate,
      deleteMany: mocks.radarFeedbackDeleteMany,
      groupBy: mocks.radarFeedbackGroupBy,
      findMany: mocks.radarFeedbackFindMany,
    },
    adminAction: { create: mocks.adminActionCreate },
    research: { create: mocks.researchCreate },
    researchSource: { create: mocks.researchSourceCreate },
    $transaction: mocks.transaction,
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
import { POST as adminRetry } from '../admin/radar/[id]/retry-interpretation/route';

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
    radarFeedback: { create: mocks.radarFeedbackCreate },
    adminAction: { create: mocks.adminActionCreate },
    research: { create: mocks.researchCreate },
    researchSource: { create: mocks.researchSourceCreate },
  }));
  mocks.summaryUpdate.mockImplementation(({ data }) => Promise.resolve({
    id: SUM_ID, status: data.status, summaryDate: new Date('2026-07-21'),
    sortOrder: data.sortOrder ?? null, selectionReason: data.selectionReason ?? null,
    publishedAt: data.publishedAt ?? null, updatedAt: new Date(),
  }));
  mocks.adminActionCreate.mockResolvedValue({ id: 'action-1', requestId: 'req-1' });
  mocks.researchCreate.mockResolvedValue({
    id: 'research-1', type: 'research', status: 'draft',
    title: 'X', creationMethod: 'ai_research', authorId: ADMIN.id,
    createdAt: new Date(),
  });
  mocks.researchSourceCreate.mockResolvedValue({ id: 'rs-1' });
  mocks.randomUUID.mockReturnValue('00000000-0000-4000-8000-000000000001');
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
    mocks.summaryFindMany.mockResolvedValue([
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
    ]);
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

  it('returns 404 for non-radar summary (source!=daily)', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUM_ID, title: 'A', body: 'a', url: 'u', tags: [], status: 'published',
      summaryDate: new Date(), publishedAt: null, createdAt: new Date(),
      interpretation: null, scoreReason: null, scoreVersion: null,
      relevanceScore: null, timelinessScore: null, sourceQualityScore: null,
      selectionReason: null, sortOrder: null, syncRunId: null, source: 'user',
      sharedBy: null, syncRun: null,
    });
    const r = await radarDetail(
      new Request('http://localhost/api/radar/x') as never,
      { params: Promise.resolve({ id: SUM_ID }) },
    );
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe('DRAFT_NOT_FOUND');
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
    mocks.radarFeedbackCreate.mockResolvedValue({ id: 'fb-1' });
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
    const r = await adminSelect(req as never, { params: { id: SUM_ID } });
    expect(r.status).toBe(403);
  });

  it('returns 400 on bad sortOrder', async () => {
    const req = new Request('http://localhost/x', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryDate: '2026-07-21', sortOrder: 99, selectionReason: 'r' }),
    });
    const r = await adminSelect(req as never, { params: { id: SUM_ID } });
    expect(r.status).toBe(400);
  });

  it('returns 404 when summary is not radar', async () => {
    mocks.summaryFindUnique.mockResolvedValue({ id: SUM_ID, source: 'user', syncRunId: null, status: 'candidate' });
    const req = new Request('http://localhost/x', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaryDate: '2026-07-21', sortOrder: 1, selectionReason: 'reason' }),
    });
    const r = await adminSelect(req as never, { params: { id: SUM_ID } });
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
    const r = await adminSelect(req as never, { params: { id: SUM_ID } });
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
    const r = await adminSelect(req as never, { params: { id: SUM_ID } });
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
    const r = await adminSelect(req as never, { params: { id: SUM_ID } });
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.actionRequestId).toBeTruthy();
    expect(mocks.summaryUpdate).toHaveBeenCalled();
    expect(mocks.adminActionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'radar_select', targetId: SUM_ID }),
    }));
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
      { params: { id: SUM_ID } },
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
      { params: { id: SUM_ID } },
    );
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.summary.status).toBe('rejected');
    expect(mocks.adminActionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'radar_dismiss' }),
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
      { params: { id: SUM_ID } },
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
      { params: { id: SUM_ID } },
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
