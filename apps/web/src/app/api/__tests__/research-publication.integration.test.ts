import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashResearchRevision } from '../../../lib/research-revision';
import { researchPublicationVersion } from '../../../lib/research-publication-version';

// Opt in explicitly. Never read .env or fall back to the application's DB.
const testUrl = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!testUrl) return false;
  const url = new URL(testUrl);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/pr56_publication_test') {
    throw new Error('Publication integration tests require the isolated localhost pr56_publication_test database');
  }
  return true;
})();
const shared = vi.hoisted(() => ({ prisma: undefined as unknown, actorId: '' }));
vi.mock('../../../lib/db.js', () => ({ get prisma() { return shared.prisma; } }));
vi.mock('../../../lib/auth/session.js', () => ({ requireUser: async () => ({ id: shared.actorId, role: 'member' }) }));

let db: PrismaClient;
let writer: PrismaClient;
let POST: typeof import('../researches/[id]/publish/route').POST;
let GET: typeof import('../researches/[id]/route').GET;
let afterSnapshotRead: (() => Promise<void>) | undefined;
let readCount = 0;

async function fixture(reviewStatus: string | null = null) {
  return db.research.create({ data: {
    type: 'research', status: 'draft', title: `Publication transaction ${crypto.randomUUID()}`,
    body: '完整报告正文', background: '研究背景', conclusion: '研究结论', risks: '风险与待验证',
    tags: [], authorId: shared.actorId, creationMethod: 'ai_research', reviewStatus,
    originContentSha256: '0'.repeat(64), aiAssisted: true,
  } });
}
async function version(id: string) {
  const row = await db.research.findUniqueOrThrow({ where: { id }, include: {
    reviewRuns: { orderBy: { createdAt: 'desc' }, include: { decisions: { orderBy: { createdAt: 'asc' } } } },
  } });
  return researchPublicationVersion(row, 'not_assessed');
}
async function publish(id: string, publicationVersion: string) {
  readCount = 0;
  return POST(new Request(`http://localhost/api/researches/${id}/publish`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ acknowledgeDisclosure: true, publicationVersion }),
  }) as never, { params: Promise.resolve({ id }) });
}
async function addRun(row: Awaited<ReturnType<typeof fixture>>, data: {
  outcome?: string; executionStatus?: string; claims?: object[];
  details?: Prisma.InputJsonValue; triggeredBy?: string; createdAt?: Date;
}) {
  return db.researchReviewRun.create({ data: {
    researchId: row.id, revisionHash: hashResearchRevision(row), sourceSnapshotHash: '0'.repeat(64),
    executionStatus: data.executionStatus ?? 'completed', outcome: data.outcome ?? 'attention',
    summary: { coverage_status: 'complete' }, claims: data.claims ?? [], attempt: 1,
    details: data.details, triggeredBy: data.triggeredBy, createdAt: data.createdAt,
  } });
}

describe.skipIf(!allowed)('publication on isolated PostgreSQL', () => {
  beforeAll(async () => {
    writer = new PrismaClient({ datasources: { db: { url: testUrl! } } });
    db = new PrismaClient({ datasources: { db: { url: testUrl! } } }).$extends({
      query: { research: { async findUnique({ args, query }) {
        const result = await query(args);
        if (afterSnapshotRead && ++readCount === 2) await afterSnapshotRead();
        return result;
      } } },
    }) as unknown as PrismaClient;
    shared.prisma = db;
    const user = await db.user.create({ data: { email: `publication-${crypto.randomUUID()}@e2e.local`, name: 'Publication regression evidence' } });
    shared.actorId = user.id;
    ({ POST } = await import('../researches/[id]/publish/route'));
    ({ GET } = await import('../researches/[id]/route'));
  });
  afterAll(async () => { await db?.$disconnect(); await writer?.$disconnect(); });

  it.each([null, 'review_unavailable', 'queued', 'reviewing'])('publishes the acknowledged reviewStatus=%s snapshot and writes one audit', async (status) => {
    const row = await fixture(status);
    if (status === 'review_unavailable') await addRun(row, { executionStatus: 'unavailable', outcome: 'unavailable' });
    const response = await publish(row.id, await version(row.id));
    expect(response.status).toBe(200);
    expect(await db.research.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'published', aiAssisted: true });
    expect(await db.researchAudit.count({ where: { researchId: row.id, action: 'publish' } })).toBe(1);
  });

  it.each(['edit', 'new_review'])('rejects a committed concurrent %s after the transaction snapshot read', async (change) => {
    const row = await fixture('needs_revision');
    const seenVersion = await version(row.id);
    let snapshotRead!: () => void;
    let resume!: () => void;
    const atSnapshot = new Promise<void>((resolve) => { snapshotRead = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    afterSnapshotRead = async () => { snapshotRead(); await resumed; };
    const pending = publish(row.id, seenVersion);
    try {
      await atSnapshot;
      if (change === 'edit') {
        await writer.research.update({ where: { id: row.id }, data: { body: '并发编辑的新报告正文' } });
      } else {
        await writer.$transaction(async (tx) => {
          await tx.researchReviewRun.create({ data: {
            researchId: row.id, revisionHash: hashResearchRevision(row), sourceSnapshotHash: '0'.repeat(64),
            executionStatus: 'completed', outcome: 'attention', claims: [{ claim_id: 'new', claim: '并发新风险', risk: 'medium', verdict: 'unverified' }],
          } });
          // The legacy value deliberately stays identical. The transaction
          // must still reject this new MVCC version instead of publishing it.
          await tx.research.update({ where: { id: row.id }, data: { reviewStatus: 'needs_revision' } });
        });
      }
    } finally { resume(); afterSnapshotRead = undefined; }
    const response = await pending;
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('AI_REVIEW_CONFLICT');
    expect((await db.research.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('draft');
    expect(await db.researchAudit.count({ where: { researchId: row.id, action: 'publish' } })).toBe(0);
  }, 15_000);

  it('rejects a stale confirmation when a different review completed before the request', async () => {
    const row = await fixture('needs_revision');
    const oldVersion = await version(row.id);
    await addRun(row, { claims: [{ claim_id: 'new', claim: '新发现的不确定性', verdict: 'unverified', risk: 'medium' }] });
    expect((await publish(row.id, oldVersion)).status).toBe(409);
    expect((await db.research.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('draft');
  });

  it('rejects high-risk contradictory evidence even with explicit acknowledgement', async () => {
    const row = await fixture('blocked');
    await addRun(row, { outcome: 'blocked', claims: [{ claim_id: 'danger', claim: '高风险结论', risk: 'high', verdict: 'contradicted', evidence: { excerpt: '明确反证' } }] });
    const response = await publish(row.id, await version(row.id));
    expect(response.status).toBe(400);
    expect((await db.research.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('draft');
    expect(await db.researchAudit.count({ where: { researchId: row.id } })).toBe(0);
  });

  it.each(['high', 'medium'])('preserves another %s-risk fact after a one-claim challenge completes clear', async (risk) => {
    const row = await fixture('passed');
    const a = { claim_id: 'a', claim: '全文清单中仍需处理的声明A', risk, verdict: risk === 'high' ? 'contradicted' : 'unverified' };
    const b = { claim_id: 'b', claim: '有证据支持的声明B', risk: 'medium', verdict: 'verified', evidence: { excerpt: 'B的直接支持原文' } };
    const full = await addRun(row, { outcome: risk === 'high' ? 'blocked' : 'attention', claims: [a, b] });
    await addRun(row, { outcome: 'clear', claims: [b], createdAt: new Date(full.createdAt.getTime() + 1000),
      triggeredBy: 'evidence_challenge', details: { reviewMode: 'evidence_challenge', targetClaim: b, requestedFromRunId: full.id } });
    const response = await POST(new Request(`http://localhost/api/researches/${row.id}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ acknowledgeDisclosure: risk === 'high', publicationVersion: await version(row.id) }),
    }) as never, { params: Promise.resolve({ id: row.id }) });
    expect(response.status).toBe(400);
    expect(await db.researchAudit.count({ where: { researchId: row.id, action: 'publish' } })).toBe(0);
    await db.research.update({ where: { id: row.id }, data: { status: 'published', publishedAt: new Date() } });
    const readerResponse = await GET(new Request(`http://localhost/api/researches/${row.id}`) as never, { params: Promise.resolve({ id: row.id }) });
    const reader = await readerResponse.json();
    expect(reader.reviewVerification).toBe(risk === 'high' ? 'conflicted' : 'unverified');
    expect(reader.reviewDisclosure).toEqual([expect.objectContaining({ claimId: 'a' })]);
  });

  it('withdraws the same target risk only, after a completed settled challenge with valid lineage', async () => {
    const row = await fixture('passed');
    const a = { claim_id: 'a', claim: '本次重新确认的相同声明A', risk: 'high', verdict: 'contradicted' };
    const b = { claim_id: 'b', claim: '尚未确认的独立声明B', risk: 'medium', verdict: 'unverified' };
    const full = await addRun(row, { outcome: 'blocked', claims: [a, b] });
    await addRun(row, { outcome: 'clear', claims: [{ ...a, verdict: 'verified', judgment_status: 'settled', evidence: { excerpt: '重新确认的支持原文' } }],
      createdAt: new Date(full.createdAt.getTime() + 1000), triggeredBy: 'evidence_challenge',
      details: { review_mode: 'evidence_challenge', targetClaim: a, requestedFromRunId: full.id } });
    const response = await publish(row.id, await version(row.id));
    expect(response.status).toBe(200);
    const reader = await (await GET(new Request(`http://localhost/api/researches/${row.id}`) as never, { params: Promise.resolve({ id: row.id }) })).json();
    expect(reader.reviewVerification).toBe('unverified');
    expect(reader.reviewDisclosure).toEqual([expect.objectContaining({ claimId: 'b' })]);
  });
});
