import { validRadarScore } from '../../../lib/radar/test-score';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  findUnique: vi.fn(),
  fetchChatEngine: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/db', () => ({ prisma: { summary: { findUnique: mocks.findUnique } } }));
vi.mock('@/lib/chat-bff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-bff')>()),
  fetchChatEngine: mocks.fetchChatEngine,
}));

import { POST } from '../chat/sessions/route';

const SEED = '11111111-1111-4111-8111-111111111111';
const req = () => new Request('http://localhost/api/chat/sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ seedSummaryId: SEED }),
}) as never;

const ok = {
  status: 'candidate', source: 'daily', syncRunId: 'r', shareSource: null, distilledScore: validRadarScore,
  distilledTier: 'deep_read', tags: [], enrichmentStatus: 'ready', readerQualityStatus: 'ready', contentReviewStatus: 'approved',
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: 'u1', role: 'member' });
});

describe('POST /api/chat/sessions seed visibility', () => {
  it.each([
    ['unscored', { ...ok, distilledScore: null }],
    ['noise', { ...ok, distilledTier: 'noise' }],
    ['unapproved deep_read', { ...ok, contentReviewStatus: 'pending' }],
    ['archived', { ...ok, status: 'archived' }],
  ])('rejects %s seeds for members', async (_name, seed) => {
    mocks.findUnique.mockResolvedValue({ id: SEED, ...seed });
    const res = await POST(req());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mocks.fetchChatEngine).not.toHaveBeenCalled();
  });
});
