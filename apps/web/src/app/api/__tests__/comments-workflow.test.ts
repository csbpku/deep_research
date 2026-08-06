import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  commentFindUnique: vi.fn(),
  commentFindMany: vi.fn(),
  commentCount: vi.fn(),
  commentUpdate: vi.fn(),
  summaryFindUnique: vi.fn(),
  researchFindUnique: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));

vi.mock('../../../lib/auth/session.js', () => ({
  requireUser: mocks.requireUser,
}));

vi.mock('../../../lib/db.js', () => ({
  prisma: {
    comment: {
      findUnique: mocks.commentFindUnique,
      findMany: mocks.commentFindMany,
      count: mocks.commentCount,
      update: mocks.commentUpdate,
    },
    summary: { findUnique: mocks.summaryFindUnique },
    research: { findUnique: mocks.researchFindUnique },
  },
}));

import { POST as nominateComment } from '../comments/[id]/nominate/route';
import { GET as listSummaryComments } from '../summaries/[id]/comments/route';
import { POST as createSummaryComment } from '../summaries/[id]/comments/route';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'member@example.com',
  name: 'Member',
  image: null,
  role: 'member' as const,
  disabledAt: null,
};
const COMMENT_ID = '22222222-2222-4222-8222-222222222222';
const SUMMARY_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
  mocks.commentFindMany.mockResolvedValue([]);
  mocks.commentCount.mockResolvedValue(0);
  mocks.commentUpdate.mockResolvedValue({ id: COMMENT_ID });
  mocks.researchFindUnique.mockResolvedValue({ id: SUMMARY_ID, status: 'published', authorId: USER.id });
});

describe('research discussion publication gate', () => {
  it('does not expose draft discussions even to the owner', async () => {
    mocks.researchFindUnique.mockResolvedValue({ id: SUMMARY_ID, status: 'draft', authorId: USER.id });

    const response = await (await import('../researches/[id]/comments/route')).GET(
      new Request(`http://localhost/api/researches/${SUMMARY_ID}/comments`) as never,
      { params: Promise.resolve({ id: SUMMARY_ID }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
  });

  it('does not allow creating a draft discussion', async () => {
    mocks.researchFindUnique.mockResolvedValue({ id: SUMMARY_ID, status: 'draft', authorId: USER.id });

    const response = await (await import('../researches/[id]/comments/route')).POST(
      new Request(`http://localhost/api/researches/${SUMMARY_ID}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'draft discussion', mentionedUserIds: [] }),
      }) as never,
      { params: Promise.resolve({ id: SUMMARY_ID }) },
    );

    expect(response.status).toBe(404);
  });
});

describe('POST /api/comments/[id]/nominate', () => {
  it('moves a top-level comment into the knowledge extraction queue', async () => {
    mocks.commentFindUnique.mockResolvedValue({
      id: COMMENT_ID,
      parentId: null,
      promoteStatus: 'none',
      summary: { status: 'candidate', source: 'daily', syncRunId: 'run-1', shareSource: null },
      research: null,
    });

    const response = await nominateComment(
      new Request('http://localhost/api/comments/x/nominate', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: COMMENT_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.promoteStatus).toBe('nominated');
    expect(mocks.commentUpdate).toHaveBeenCalledWith({
      where: { id: COMMENT_ID },
      data: { promoteStatus: 'nominated' },
      select: { id: true },
    });
  });

  it('is idempotent when the comment is already nominated', async () => {
    mocks.commentFindUnique.mockResolvedValue({
      id: COMMENT_ID,
      parentId: null,
      promoteStatus: 'nominated',
      summary: null,
      research: { status: 'published' },
    });

    const response = await nominateComment(
      new Request('http://localhost/api/comments/x/nominate', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: COMMENT_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.commentUpdate).not.toHaveBeenCalled();
  });

  it('rejects nominating a reply without its parent context', async () => {
    mocks.commentFindUnique.mockResolvedValue({
      id: COMMENT_ID,
      parentId: '44444444-4444-4444-8444-444444444444',
      promoteStatus: 'none',
      summary: { status: 'candidate', source: 'daily', syncRunId: 'run-1', shareSource: null },
      research: null,
    });

    const response = await nominateComment(
      new Request('http://localhost/api/comments/x/nominate', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: COMMENT_ID }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.commentUpdate).not.toHaveBeenCalled();
  });
});

describe('GET /api/summaries/[id]/comments', () => {
  it('allows discussion on an approved user-shared radar article', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUMMARY_ID,
      status: 'candidate',
      source: 'user',
      syncRunId: null,
      shareSource: { status: 'approved' },
    });

    const response = await listSummaryComments(
      new Request(`http://localhost/api/summaries/${SUMMARY_ID}/comments`) as never,
      { params: Promise.resolve({ id: SUMMARY_ID }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 0, items: [] });
  });

  it('does not expose comments for an unapproved user share', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: SUMMARY_ID,
      status: 'candidate',
      source: 'user',
      syncRunId: null,
      shareSource: { status: 'pending' },
    });

    const response = await listSummaryComments(
      new Request(`http://localhost/api/summaries/${SUMMARY_ID}/comments`) as never,
      { params: Promise.resolve({ id: SUMMARY_ID }) },
    );

    expect(response.status).toBe(404);
  });
});

describe('POST /api/summaries/[id]/comments validation', () => {
  it('reports the comment length limit instead of a generic error', async () => {
    const response = await createSummaryComment(
      new Request(`http://localhost/api/summaries/${SUMMARY_ID}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'x'.repeat(2001), mentionedUserIds: [] }),
      }) as never,
      { params: Promise.resolve({ id: SUMMARY_ID }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.message).toBe('请检查必填项和输入格式');
    expect(payload.details.fieldErrors.body[0]).toBe('评论最多 2000 字');
  });

  it('reports the mention limit instead of a generic error', async () => {
    const mentionedUserIds = Array.from(
      { length: 11 },
      (_, index) => `${index}`.padStart(8, '1') + '-1111-4111-8111-111111111111',
    );
    const response = await createSummaryComment(
      new Request(`http://localhost/api/summaries/${SUMMARY_ID}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'hello', mentionedUserIds }),
      }) as never,
      { params: Promise.resolve({ id: SUMMARY_ID }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.details.fieldErrors.mentionedUserIds[0]).toBe('一次最多 @ 10 位成员');
  });
});
