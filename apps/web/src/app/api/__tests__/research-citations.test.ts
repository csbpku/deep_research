import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  researchFindUnique: vi.fn(),
  sourceFindFirst: vi.fn(),
  citationUpsert: vi.fn(),
  citationFindMany: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('../../../lib/auth/session.js', () => ({ requireUser: mocks.requireUser }));
vi.mock('../../../lib/db.js', () => ({
  prisma: {
    research: { findUnique: mocks.researchFindUnique },
    researchSource: { findFirst: mocks.sourceFindFirst },
    researchCitation: { upsert: mocks.citationUpsert, findMany: mocks.citationFindMany },
  },
}));

import { POST } from '../researches/[id]/citations/route';

const USER = { id: '11111111-1111-4111-8111-111111111111', role: 'member' };
const RESEARCH_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_ID = '33333333-3333-4333-8333-333333333333';
const BODY = '前文正文片段后文';
const HASH = createHash('sha256').update(BODY).digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
  mocks.researchFindUnique.mockResolvedValue({ id: RESEARCH_ID, status: 'draft', authorId: USER.id, body: BODY });
  mocks.sourceFindFirst.mockResolvedValue({ id: SOURCE_ID, researchId: RESEARCH_ID });
  mocks.citationUpsert.mockResolvedValue({ id: 'citation-1', marker: '[^source-1]' });
});

function request(payload: unknown) {
  return POST(
    new Request(`http://localhost/api/researches/${RESEARCH_ID}/citations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }) as never,
    { params: Promise.resolve({ id: RESEARCH_ID }) },
  );
}

describe('POST /api/researches/[id]/citations', () => {
  it('rejects a stale quote before writing a citation', async () => {
    const response = await request({ sourceId: SOURCE_ID, marker: '[^source-1]', quote: '旧片段', startOffset: 2, endOffset: 6, contentHash: 'a'.repeat(64) });
    expect(response.status).toBe(400);
    expect(mocks.citationUpsert).not.toHaveBeenCalled();
  });

  it('rejects a source that is not attached to the research', async () => {
    mocks.sourceFindFirst.mockResolvedValueOnce(null);
    const response = await request({ sourceId: SOURCE_ID, marker: '[^source-1]', quote: '正文片段', startOffset: 2, endOffset: 6, contentHash: HASH });
    expect(response.status).toBe(400);
  });

  it('writes a valid citation with the stable anchor fields', async () => {
    const response = await request({ sourceId: SOURCE_ID, marker: '[^source-1]', quote: '正文片段', startOffset: 2, endOffset: 6, contentHash: HASH });
    expect(response.status).toBe(201);
    expect(mocks.citationUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ researchId: RESEARCH_ID, sourceId: SOURCE_ID, quote: '正文片段', startOffset: 2, endOffset: 6, contentHash: HASH }),
    }));
  });
});
