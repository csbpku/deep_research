import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireReadingUser: vi.fn(),
  upsert: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock('../../../../lib/api-handler', () => ({
  apiHandler: (handler: unknown) => handler,
  parseBody: async (req: Request, schema: { parse: (value: unknown) => unknown }) => schema.parse(await req.json()),
}));
vi.mock('../../../../lib/reading-auth', () => ({ requireReadingUser: mocks.requireReadingUser }));
vi.mock('../../../../lib/db', () => ({
  prisma: { readingSession: { upsert: mocks.upsert, findMany: mocks.findMany } },
}));

import { GET, POST } from '../session/route';

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'reader@example.com', role: 'member' as const };
const INPUT = {
  clientId: '22222222-2222-4222-8222-222222222222',
  idempotencyKey: '33333333-3333-4333-8333-333333333333',
  document: { url: 'https://example.com/docs', title: 'Docs', version: 'sha256:page-1' },
  state: {
    selection: { quote: 'A paragraph', prefix: '', suffix: '' },
    answer: 'Reusable conclusion',
    discussion: [{ role: 'user', content: 'Why?' }],
    discussionScope: 'selection',
    scrollY: 120,
    scrollHeight: 1600,
  },
};

function request(input: unknown): Request {
  return new Request('http://localhost/api/reading/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireReadingUser.mockResolvedValue(USER);
  mocks.upsert.mockResolvedValue({
    clientId: INPUT.clientId,
    documentUrl: INPUT.document.url,
    title: INPUT.document.title,
    documentVersion: INPUT.document.version,
    state: INPUT.state,
    updatedAt: new Date('2026-09-20T00:00:00.000Z'),
  });
  mocks.findMany.mockResolvedValue([]);
});

describe('browser reading session sync', () => {
  it('upserts only bounded session metadata for the authenticated user', async () => {
    const response = await POST(request(INPUT) as never);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.session.document.url).toBe(INPUT.document.url);
    expect(payload.session.state.answer).toBe('Reusable conclusion');
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_clientId_documentKey: expect.objectContaining({ userId: USER.id, clientId: INPUT.clientId }) },
      create: expect.objectContaining({ userId: USER.id, state: INPUT.state, lastSyncKey: INPUT.idempotencyKey }),
    }));
  });

  it('lists only the current user sessions', async () => {
    mocks.findMany.mockResolvedValue([{
      clientId: INPUT.clientId,
      documentUrl: INPUT.document.url,
      title: INPUT.document.title,
      documentVersion: INPUT.document.version,
      state: INPUT.state,
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
    }]);
    const response = await GET(new Request(`http://localhost/api/reading/session?clientId=${INPUT.clientId}`) as never);
    expect(response.status).toBe(200);
    expect((await response.json()).sessions).toHaveLength(1);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER.id, clientId: INPUT.clientId } }));
  });
});
