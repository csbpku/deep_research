import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
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
    $queryRawUnsafe: mocks.queryRawUnsafe,
  },
}));

import { DELETE, PATCH } from '../radar/annotations/[id]/route';

const USER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'reader@example.com',
  name: 'Reader',
  role: 'member' as const,
  disabledAt: null,
};

const ANNOTATION_ID = '33333333-3333-3333-3333-333333333333';

function request(method: 'PATCH' | 'DELETE', body?: unknown) {
  return new NextRequest(`http://localhost/api/radar/annotations/${ANNOTATION_ID}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function params() {
  return { params: Promise.resolve({ id: ANNOTATION_ID }) };
}

describe('PATCH /api/radar/annotations/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue(USER);
    mocks.queryRawUnsafe.mockResolvedValueOnce([{ id: ANNOTATION_ID }]);
  });

  it('updates only the current user annotation body', async () => {
    const response = await PATCH(request('PATCH', { body: '更新后的批注' }), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: ANNOTATION_ID });
    expect(mocks.queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('"authorId" = $4::uuid'),
      ANNOTATION_ID,
      '更新后的批注',
      null,
      USER.id,
    );
  });

  it('rejects an empty patch', async () => {
    const response = await PATCH(request('PATCH', {}), params());

    expect(response.status).toBe(400);
    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/radar/annotations/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue(USER);
    mocks.queryRawUnsafe.mockResolvedValueOnce([{ id: ANNOTATION_ID }]);
  });

  it('deletes the current user annotation', async () => {
    const response = await DELETE(request('DELETE'), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM radar_annotations'),
      ANNOTATION_ID,
      USER.id,
    );
  });
});
