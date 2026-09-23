import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireReadingUser: vi.fn(),
  transaction: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('../../../../lib/api-handler', () => ({
  apiHandler: (handler: unknown) => handler,
  parseBody: async (req: Request, schema: { parse: (value: unknown) => unknown }) => schema.parse(await req.json()),
}));
vi.mock('../../../../lib/reading-auth', () => ({ requireReadingUser: mocks.requireReadingUser }));
vi.mock('../../../../lib/db', () => ({
  prisma: { $transaction: mocks.transaction, research: { findFirst: mocks.findFirst } },
}));

import { POST } from '../save/route';

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'reader@example.com', role: 'member' as const };
const body = 'A paragraph from the original page.';
const validAnchor = {
  quote: body,
  prefix: '',
  suffix: '',
  startOffset: 0,
  endOffset: body.length,
  contentHash: 'a'.repeat(64),
};

function request(input: unknown): Request {
  return new Request('http://localhost/api/reading/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireReadingUser.mockResolvedValue(USER);
});

describe('POST /api/reading/save', () => {
  it('rejects an edited quote while retaining the old anchor', async () => {
    const response = await POST(request({
      url: 'https://example.com/docs',
      title: 'Docs',
      quote: 'An edited paragraph.',
      anchor: validAnchor,
    }) as never);
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain('锚点');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects an incomplete anchor instead of saving an unverifiable citation', async () => {
    const response = await POST(request({
      url: 'https://example.com/docs',
      title: 'Docs',
      quote: body,
      anchor: { quote: body },
    }) as never);
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain('位置或内容指纹');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
