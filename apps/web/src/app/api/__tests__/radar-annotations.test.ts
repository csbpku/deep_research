import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  summaryFindUnique: vi.fn(),
  queryRawUnsafe: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', () => ({
  apiHandler: (handler: unknown) => handler,
  parseBody: async (request: Request, schema: { parse: (value: unknown) => unknown }) => schema.parse(await request.json()),
}));

vi.mock('../../../lib/auth/session.js', () => ({
  requireUser: mocks.requireUser,
}));

vi.mock('../../../lib/db.js', () => ({
  prisma: {
    summary: { findUnique: mocks.summaryFindUnique },
    $queryRawUnsafe: mocks.queryRawUnsafe,
  },
}));

import { GET, POST } from '../radar/annotations/route';

const USER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'reader@example.com',
  name: 'Reader',
  role: 'member' as const,
  disabledAt: null,
};

function request() {
  return new NextRequest('http://localhost/api/radar/annotations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      summaryId: '22222222-2222-2222-2222-222222222222',
      kind: 'highlight',
      quote: 'A saved quote',
      startOffset: 0,
      endOffset: 13,
    }),
  });
}

describe('POST /api/radar/annotations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue(USER);
    mocks.queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([{
      id: '33333333-3333-3333-3333-333333333333',
    }]);
  });

  it('allows annotations on visible radar candidates', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: '22222222-2222-2222-2222-222222222222',
      status: 'candidate',
    });

    const response = await POST(request());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: '33333333-3333-3333-3333-333333333333' });
    expect(mocks.queryRawUnsafe).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('"summaryId" = $1::uuid AND "authorId" = $2::uuid'),
      '22222222-2222-2222-2222-222222222222',
      USER.id,
      'A saved quote',
      'highlight',
    );
    expect(mocks.queryRawUnsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('VALUES ($1::uuid, $2::uuid'),
      '22222222-2222-2222-2222-222222222222',
      USER.id,
      'highlight',
      'A saved quote',
      0,
      13,
      null,
      null,
    );
  });

  it('still rejects archived summaries', async () => {
    mocks.summaryFindUnique.mockResolvedValue({
      id: '22222222-2222-2222-2222-222222222222',
      status: 'archived',
    });

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('GET /api/radar/annotations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue(USER);
    mocks.queryRawUnsafe.mockResolvedValueOnce([]);
  });

  it('casts uuid query parameters when filtering by author', async () => {
    const response = await GET(new NextRequest(
      'http://localhost/api/radar/annotations?summaryId=22222222-2222-2222-2222-222222222222&mine=true',
      { method: 'GET' },
    ));

    expect(response.status).toBe(200);
    expect(mocks.queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('a."summaryId" = $1::uuid AND a."authorId" = $2::uuid'),
      '22222222-2222-2222-2222-222222222222',
      USER.id,
    );
  });
});
