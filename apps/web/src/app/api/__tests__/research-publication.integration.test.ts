import { PrismaClient } from '@prisma/client';
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
async function addRun(row: Awaited<ReturnType<typeof fixture>>, data: { outcome?: string; executionStatus?: string; claims?: object[] }) {
  return db.researchReviewRun.create({ data: {
    researchId: row.id, revisionHash: hashResearchRevision(row), sourceSnapshotHash: '0'.repeat(64),
    executionStatus: data.executionStatus ?? 'completed', outcome: data.outcome ?? 'attention',
    summary: { coverage_status: 'complete' }, claims: data.claims ?? [], attempt: 1,
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
});
