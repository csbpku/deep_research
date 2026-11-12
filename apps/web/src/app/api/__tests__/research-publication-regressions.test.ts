import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashResearchRevision } from '../../../lib/research-revision';
import { buildResearchMarkdown } from '../../../lib/export-research-markdown';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(), txFindUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn(),
  transaction: vi.fn(), audit: vi.fn(), event: vi.fn(),
}));
vi.mock('../../../lib/api-handler.js', async (original) => ({
  ...await original<typeof import('../../../lib/api-handler.js')>(), apiHandler: (fn: unknown) => fn,
}));
vi.mock('../../../lib/auth/session.js', () => ({ requireUser: async () => ({ id: '11111111-1111-4111-8111-111111111111', role: 'member' }) }));
vi.mock('../../../lib/product-events.js', () => ({ recordProductEvent: async () => {}, buildWeeklyProductEventDedupeKey: () => 'test' }));
vi.mock('../../../lib/db.js', () => ({ prisma: {
  research: { findUnique: mocks.findUnique },
  researchAudit: { findMany: async () => [] }, researchSource: { findMany: async () => [] },
  $transaction: mocks.transaction,
} }));
import { GET } from '../researches/[id]/route';
import { POST } from '../researches/[id]/publish/route';

const id = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-11-12T10:00:00Z');
const base = {
  id, type: 'research', status: 'published', title: '风险报告', body: '报告正文',
  background: '背景', conclusion: '结论', risks: '待验证', tags: [],
  authorId: '11111111-1111-4111-8111-111111111111', creationMethod: 'ai_research',
  aiAssisted: true, reviewStatus: 'needs_revision', reviewAttempts: 1,
  reviewSummary: null, reviewClaims: [], reviewDetails: null,
  originContentSha256: null, supersedesResearchId: null, reviewedAt: now,
  reviewRunToken: null, publishedAt: now, featuredAt: null, createdAt: now, updatedAt: now,
  author: { id: '11111111-1111-4111-8111-111111111111', name: '作者', email: 'author@e2e.local' },
  _count: { comments: 0 }, sourceAiJob: null,
};
const a = { claim_id: 'a', claim: '已接受但尚未核验的结论', risk: 'medium', verdict: 'unverified' };
const b = { claim_id: 'b', claim: '仍未核验的另一结论', risk: 'medium', verdict: 'unverified' };
const decision = { id: 'decision-a', claimId: 'a', action: 'accept_uncertainty', reason: '作者接受作为下一轮待验证项', actorId: base.authorId, createdAt: now };
function run(overrides: Record<string, unknown> = {}) {
  return { id: '33333333-3333-4333-8333-333333333333', revisionHash: hashResearchRevision(base),
    executionStatus: 'completed', outcome: 'attention', attempt: 1,
    summary: { coverage_status: 'complete' }, claims: [a], decisions: [decision],
    createdAt: now, ...overrides };
}
const params = { params: Promise.resolve({ id }) };
async function detail(row: Record<string, unknown>) {
  mocks.findUnique.mockResolvedValue(row);
  const response = await GET(new Request(`http://localhost/api/researches/${id}`) as never, params);
  expect(response.status).toBe(200);
  return response.json();
}
function setupPublish(row: Record<string, unknown>, fresh = row) {
  mocks.findUnique.mockResolvedValue(row);
  mocks.txFindUnique.mockResolvedValue(fresh);
  mocks.updateMany.mockImplementation(async ({ where }: { where: { reviewStatus?: string | null | { in: string[] } } }) => {
    const predicate = where.reviewStatus;
    const matches = predicate === undefined || (typeof predicate === 'object' && predicate !== null
      ? predicate.in.includes(fresh.reviewStatus as string) : predicate === fresh.reviewStatus);
    return { count: matches ? 1 : 0 };
  });
  mocks.update.mockResolvedValue({ ...fresh, status: 'published', aiAssisted: true });
}
async function publish(version: string | undefined) {
  return POST(new Request(`http://localhost/api/researches/${id}/publish`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ acknowledgeDisclosure: true, publicationVersion: version }),
  }) as never, params);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation((cb) => cb({
    research: { findUnique: mocks.txFindUnique, updateMany: mocks.updateMany, update: mocks.update },
    researchAudit: { create: mocks.audit }, productEvent: { create: mocks.event },
  }));
});

describe('reader risks survive publication and re-verification', () => {
  it('exposes a newly discovered high-risk contradiction on a published report', async () => {
    const payload = await detail({ ...base, reviewStatus: 'blocked', reviewRuns: [run({ outcome: 'blocked',
      claims: [{ ...b, risk: 'high', verdict: 'contradicted', evidence: { excerpt: '来源反证' } }], decisions: [] })] });
    expect(payload.reviewDisclosureSummary?.hardBlockCount).toBe(1);
    expect(payload.reviewDisclosure).toEqual(expect.arrayContaining([expect.objectContaining({ claimId: 'b', evidenceStatus: 'contradicted' })]));
    expect(payload.reviewVerification).not.toBe('verified');
  });
  it.each(['queued', 'reviewing', 'unavailable', 'stale'])('retains the same revision previous risks while the newest run is %s', async (executionStatus) => {
    const payload = await detail({ ...base, reviewRuns: [
      run({ id: '44444444-4444-4444-8444-444444444444', executionStatus, outcome: executionStatus === 'unavailable' ? 'unavailable' : null, claims: [], decisions: [], createdAt: new Date(now.getTime() + 1000) }), run(),
    ] });
    expect(payload.reviewDisclosureSummary?.machineIncomplete).toBe(true);
    expect(payload.reviewDisclosure).toEqual(expect.arrayContaining([expect.objectContaining({ claimId: 'a', reason: decision.reason })]));
    expect(payload.reviewVerification).not.toBe('verified');
  });
  it('keeps both accepted and still-open risks, including the author reason', async () => {
    const payload = await detail({ ...base, reviewRuns: [run({ claims: [a, b] })] });
    expect(payload.reviewDisclosure.map((item: { claimId: string }) => item.claimId).sort()).toEqual(['a', 'b']);
    expect(payload.reviewDisclosure.find((item: { claimId: string }) => item.claimId === 'a').reason).toBe(decision.reason);
  });
  it('marks an AI report with no current review as unverified', async () => {
    const payload = await detail({ ...base, reviewStatus: null, reviewRuns: [] });
    expect(payload.reviewDisclosureSummary?.machineIncomplete).toBe(true);
    expect(payload.reviewVerification).not.toBe('verified');
  });
  it('carries the same disclosure and author reasons into the Markdown export', async () => {
    const payload = await detail({ ...base, reviewRuns: [run({ claims: [a, b] })] });
    const markdown = buildResearchMarkdown(payload);
    expect(markdown).toContain('核验与披露');
    expect(markdown).toContain(a.claim);
    expect(markdown).toContain(b.claim);
    expect(markdown).toContain(decision.reason);
  });
  it('lets a completed clear replacement supersede previous findings on the same revision', async () => {
    const payload = await detail({ ...base, reviewRuns: [
      run({ id: 'new', createdAt: new Date(now.getTime() + 1000), outcome: 'clear',
        claims: [{ ...a, verdict: 'verified', evidence: { excerpt: '直接支持的来源原文' } }], decisions: [] }), run(),
    ] });
    expect(payload.reviewVerification).toBe('verified');
    expect(payload.reviewDisclosure).toEqual([]);
    expect(payload.reviewDisclosureSummary).toBeNull();
  });
  it('does not transfer the previous text revision warnings onto an edited report', async () => {
    const payload = await detail({ ...base, body: '编辑后的新正文', reviewRuns: [run()] });
    expect(payload.reviewDisclosure).toEqual([]);
    expect(payload.reviewDisclosureSummary.machineIncomplete).toBe(true);
  });
  it('preserves a known high-risk contradiction while a failed retry only has partial lower-risk findings', async () => {
    const payload = await detail({ ...base, reviewRuns: [
      run({ id: 'failed', executionStatus: 'unavailable', outcome: 'unavailable',
        createdAt: new Date(now.getTime() + 1000), claims: [{ ...b, verdict: 'contradicted' }], decisions: [] }),
      run({ outcome: 'blocked', claims: [{ ...b, risk: 'high', verdict: 'contradicted' }], decisions: [] }),
    ] });
    expect(payload.reviewVerification).toBe('conflicted');
    expect(payload.reviewDisclosureSummary.hardBlockCount).toBe(1);
    expect(buildResearchMarkdown(payload)).toContain('高风险来源冲突');
  });
  it('keeps the author acceptance when a partial failed retry repeats the same unresolved claim', async () => {
    const payload = await detail({ ...base, reviewRuns: [
      run({ id: 'failed', executionStatus: 'unavailable', outcome: 'unavailable',
        createdAt: new Date(now.getTime() + 1000), claims: [a], decisions: [] }), run(),
    ] });
    expect(payload.reviewDisclosure).toEqual([expect.objectContaining({ action: 'accept_uncertainty', reason: decision.reason })]);
    expect(payload.reviewDisclosureSummary.disclosedCount).toBe(1);
  });
  it('loads the exact revision risk history when twenty failed retries filled the history panel', async () => {
    const retries = Array.from({ length: 20 }, (_, index) => run({ id: `failed-${index}`,
      executionStatus: 'unavailable', outcome: 'unavailable', claims: [], decisions: [], createdAt: new Date(now.getTime() + index + 1) }));
    mocks.findUnique.mockResolvedValueOnce({ ...base, reviewRuns: retries })
      .mockResolvedValueOnce({ reviewRuns: [...retries, run()] });
    const response = await GET(new Request(`http://localhost/api/researches/${id}`) as never, params);
    const payload = await response.json();
    expect(payload.reviewDisclosure[0]).toMatchObject({ claimId: 'a', reason: decision.reason });
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('publication snapshot compare-and-set', () => {
  it('requires the reviewed publication version for an explicit AI disclosure acknowledgement', async () => {
    setupPublish({ ...base, status: 'draft', reviewStatus: null, reviewRuns: [] });
    const response = await publish(undefined);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('AI_REVIEW_CONFLICT');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each([null, 'review_unavailable', 'queued', 'reviewing'])('publishes an explicitly acknowledged draft with reviewStatus=%s', async (reviewStatus) => {
    const row = { ...base, status: 'draft', reviewStatus, reviewRuns: [] };
    const payload = await detail(row);
    setupPublish(row);
    const response = await publish(payload.publicationVersion);
    expect(response.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledOnce();
  });
  it('rejects a content change with the same legacy review status after the initial read', async () => {
    const row = { ...base, status: 'draft', reviewRuns: [run({ claims: [a, b] })] };
    const payload = await detail(row);
    setupPublish(row, { ...row, body: '并发编辑后的不同正文', updatedAt: new Date(now.getTime() + 1000) });
    const response = await publish(payload.publicationVersion);
    expect(response.status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('rejects a new review that completed between confirmation and request', async () => {
    const row = { ...base, status: 'draft', reviewRuns: [run()] };
    const payload = await detail(row);
    const changed = { ...row, reviewRuns: [run({ id: '44444444-4444-4444-8444-444444444444', claims: [a, b] })] };
    setupPublish(changed);
    expect((await publish(payload.publicationVersion)).status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('does not let an unfinished retry bypass a previous high-risk conflict on the same text', async () => {
    const row = { ...base, status: 'draft', reviewStatus: 'queued', reviewRuns: [
      run({ id: 'new', executionStatus: 'queued', outcome: null, claims: [], decisions: [], createdAt: new Date(now.getTime() + 1) }),
      run({ outcome: 'blocked', claims: [{ ...b, risk: 'high', verdict: 'contradicted' }], decisions: [] }),
    ] };
    const payload = await detail(row);
    expect(payload.publicationHardBlocked).toBe(true);
    setupPublish(row);
    expect((await publish(payload.publicationVersion)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
