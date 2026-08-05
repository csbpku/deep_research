import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  userBookmarkFindMany: vi.fn(),
  userBookmarkFindUnique: vi.fn(),
  userBookmarkFindFirst: vi.fn(),
  userBookmarkCreate: vi.fn(),
  userBookmarkDeleteMany: vi.fn(),
  summaryFindMany: vi.fn(),
  summaryFindUnique: vi.fn(),
  researchFindMany: vi.fn(),
  radarFeedbackUpsert: vi.fn(),
  radarFeedbackDeleteMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));

vi.mock('../../../lib/auth/session.js', () => ({ requireUser: mocks.requireUser }));

vi.mock('../../../lib/db.js', () => ({
  prisma: {
    userBookmark: {
      findMany: mocks.userBookmarkFindMany,
      findUnique: mocks.userBookmarkFindUnique,
      findFirst: mocks.userBookmarkFindFirst,
      create: mocks.userBookmarkCreate,
      deleteMany: mocks.userBookmarkDeleteMany,
    },
    summary: {
      findMany: mocks.summaryFindMany,
      findUnique: mocks.summaryFindUnique,
    },
    research: { findMany: mocks.researchFindMany },
    radarFeedback: {
      upsert: mocks.radarFeedbackUpsert,
      deleteMany: mocks.radarFeedbackDeleteMany,
    },
    $transaction: mocks.transaction,
  },
}));

import { DELETE, GET, POST } from '../me/bookmarks/route';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'member@example.com',
  name: 'Member',
  image: null,
  role: 'member' as const,
  disabledAt: null,
};
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const BOOKMARK_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
  mocks.summaryFindMany.mockResolvedValue([]);
  mocks.researchFindMany.mockResolvedValue([]);
  mocks.transaction.mockImplementation((callback) => callback({
    userBookmark: {
      create: mocks.userBookmarkCreate,
      deleteMany: mocks.userBookmarkDeleteMany,
    },
    radarFeedback: {
      upsert: mocks.radarFeedbackUpsert,
      deleteMany: mocks.radarFeedbackDeleteMany,
    },
  }));
});

describe('/api/me/bookmarks', () => {
  it('returns a readable title, type label and target link', async () => {
    mocks.userBookmarkFindMany.mockResolvedValue([{
      id: BOOKMARK_ID,
      targetType: 'radar_candidate',
      targetId: TARGET_ID,
      note: '稍后细读',
      createdAt: new Date('2026-08-04T00:00:00Z'),
    }]);
    mocks.summaryFindMany.mockResolvedValue([{ id: TARGET_ID, title: 'Postgres 18 技术解读' }]);

    const response = await GET(new Request('http://localhost/api/me/bookmarks') as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items[0]).toMatchObject({
      targetLabel: '雷达',
      title: 'Postgres 18 技术解读',
      href: `/radar/${TARGET_ID}`,
      available: true,
    });
  });

  it('marks bookmarks whose target was deleted instead of exposing a raw UUID', async () => {
    mocks.userBookmarkFindMany.mockResolvedValue([{
      id: BOOKMARK_ID,
      targetType: 'research',
      targetId: TARGET_ID,
      note: null,
      createdAt: new Date('2026-08-04T00:00:00Z'),
    }]);

    const response = await GET(new Request('http://localhost/api/me/bookmarks') as never);
    const body = await response.json();

    expect(body.items[0]).toMatchObject({ title: '内容已不存在', href: null, available: false });
  });

  it('creates a radar bookmark and favorite feedback in one transaction', async () => {
    mocks.summaryFindUnique.mockResolvedValue({ source: 'daily', syncRunId: TARGET_ID });
    mocks.userBookmarkFindUnique.mockResolvedValue(null);
    mocks.userBookmarkCreate.mockResolvedValue({ id: BOOKMARK_ID, createdAt: new Date('2026-08-04T00:00:00Z') });
    mocks.radarFeedbackUpsert.mockResolvedValue({ id: 'feedback' });

    const response = await POST(new Request('http://localhost/api/me/bookmarks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetType: 'radar_candidate', targetId: TARGET_ID }),
    }) as never);

    expect(response.status).toBe(201);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.radarFeedbackUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ summaryId: TARGET_ID, userId: USER.id, feedbackType: 'favorite' }),
    }));
  });

  it('removes both sides of a radar favorite in one transaction', async () => {
    mocks.userBookmarkFindFirst.mockResolvedValue({ targetType: 'radar_candidate', targetId: TARGET_ID });
    mocks.userBookmarkDeleteMany.mockResolvedValue({ count: 1 });
    mocks.radarFeedbackDeleteMany.mockResolvedValue({ count: 1 });

    const response = await DELETE(new Request(
      `http://localhost/api/me/bookmarks?id=${BOOKMARK_ID}`,
      { method: 'DELETE' },
    ) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deleted).toBe(1);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.radarFeedbackDeleteMany).toHaveBeenCalledWith({
      where: { summaryId: TARGET_ID, userId: USER.id, feedbackType: 'favorite' },
    });
  });
});
