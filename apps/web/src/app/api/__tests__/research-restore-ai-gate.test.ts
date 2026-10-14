import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashResearchRevision } from '@/lib/research-revision';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RESEARCH_ID = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  researchFindUnique: vi.fn(),
  researchUpdate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/db', () => ({
  prisma: {
    research: { findUnique: mocks.researchFindUnique },
    $transaction: mocks.transaction,
  },
}));

import { POST } from '../researches/[id]/restore/route';

const fields = { title: 't', body: 'reviewed body', background: null, conclusion: null, risks: null, tags: [] as string[] };

function archivedAi(body: string, runs: Array<Record<string, unknown>>) {
  return {
    id: RESEARCH_ID, authorId: USER_ID, status: 'archived', publishedAt: new Date(), type: 'research',
    creationMethod: 'ai_research', ...fields, body, reviewStatus: 'passed', reviewRuns: runs,
  };
}
const passingRun = {
  id: 'run-1', revisionHash: hashResearchRevision(fields), executionStatus: 'completed', outcome: 'clear',
  attempt: 1, summary: { coverage: { status: 'sufficient' } }, claims: [], decisions: [], createdAt: new Date(),
};

const restore = () => POST(
  new Request(`http://localhost/api/researches/${RESEARCH_ID}/restore`, { method: 'POST' }) as never,
  { params: Promise.resolve({ id: RESEARCH_ID }) },
);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'member' });
  mocks.researchUpdate.mockResolvedValue({ id: RESEARCH_ID, status: 'published', updatedAt: new Date() });
  mocks.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
    research: { findUnique: mocks.researchFindUnique, update: mocks.researchUpdate },
    researchAudit: { create: mocks.auditCreate },
  }));
});

describe('POST /api/researches/[id]/restore for AI research', () => {
  it('blocks restore when the edited revision has no passing review', async () => {
    mocks.researchFindUnique.mockResolvedValue(archivedAi('edited after archive', [passingRun]));
    const res = await restore();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'AI_REVIEW_CONFLICT' });
    expect(mocks.researchUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('restores when the existing review still matches the current revision', async () => {
    mocks.researchFindUnique.mockResolvedValue(archivedAi('reviewed body', [passingRun]));
    const res = await restore();
    expect(res.status).toBe(200);
    expect(mocks.researchUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });
});
