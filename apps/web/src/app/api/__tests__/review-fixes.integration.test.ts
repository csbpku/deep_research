import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashResearchRevision } from '../../../lib/research-revision';
import { researchListWhere } from '../../../lib/research-list-where';
import { getReviewQueueCounts } from '../../../lib/review-queue-count';

const testUrl = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!testUrl) return false;
  const url = new URL(testUrl);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/pr56_publication_test') {
    throw new Error('Review regression tests require the isolated localhost pr56_publication_test database');
  }
  return true;
})();
const shared = vi.hoisted(() => ({ prisma: undefined as unknown, actorId: '' }));
vi.mock('../../../lib/db', () => ({ get prisma() { return shared.prisma; } }));
vi.mock('../../../lib/auth/session', () => ({ requireUser: async () => ({ id: shared.actorId, role: 'member' }) }));

describe.skipIf(!allowed)('review fixes on isolated PostgreSQL', () => {
  let db: PrismaClient;
  let batch: typeof import('../researches/[id]/review/decisions/batch/route').POST;
  let judgement: typeof import('../researches/[id]/judgement/route').POST;
  let selfCheck: typeof import('../learning/self-check/route').POST;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: testUrl! } } });
    shared.prisma = db;
    shared.actorId = (await db.user.create({ data: { email: `review-fixes-${crypto.randomUUID()}@e2e.local`, name: 'Review owner' } })).id;
    ({ POST: batch } = await import('../researches/[id]/review/decisions/batch/route'));
    ({ POST: judgement } = await import('../researches/[id]/judgement/route'));
    ({ POST: selfCheck } = await import('../learning/self-check/route'));
  });
  afterAll(async () => { await db?.$disconnect(); });

  function req(path: string, body: unknown) {
    return new Request(`http://localhost/api/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) as never;
  }

  async function card(authorId = shared.actorId) {
    return db.research.create({ data: {
      type: 'knowledge', status: 'published', authorId, title: `Review ${crypto.randomUUID()}`, body: 'Captured evidence.',
      judgement: 'The original claim is supported.', judgementConfidence: 'low', judgementScope: 'Original scope.',
      judgementReviewAt: new Date('2020-01-01'), publishedAt: new Date(),
    } });
  }

  it('serializes concurrent batch accepts into one durable decision', async () => {
    const research = await db.research.create({ data: {
      type: 'research', status: 'published', title: 'Concurrent decisions', body: 'One factual claim.',
      background: 'Background', conclusion: 'Conclusion', risks: 'Risks', authorId: shared.actorId,
      creationMethod: 'ai_research', originContentSha256: '0'.repeat(64), aiAssisted: true,
    } });
    const run = await db.researchReviewRun.create({ data: {
      researchId: research.id, revisionHash: hashResearchRevision(research), sourceSnapshotHash: '0'.repeat(64),
      executionStatus: 'completed', outcome: 'attention', summary: { coverage_status: 'complete' },
      claims: [{ claim_id: 'C1', claim: 'One factual claim.', claim_type: 'external_fact', verdict: 'unverified', risk: 'low' }],
    } });
    const responses = await Promise.all(Array.from({ length: 6 }, () => batch(
      req(`researches/${research.id}/review/decisions/batch`, { runId: run.id, claimIds: ['C1'], reason: 'Explicitly accepted uncertainty.' }),
      { params: Promise.resolve({ id: research.id }) },
    )));
    expect(responses.map(response => response.status)).toEqual(Array(6).fill(201));
    const results = await Promise.all(responses.map(response => response.json()));
    expect(results.reduce((sum, result) => sum + result.acceptedCount, 0)).toBe(1);
    expect(await db.researchReviewDecision.count({ where: { researchReviewRunId: run.id, claimId: 'C1' } })).toBe(1);
  });

  it('starts, preserves, clears and restarts the weak interval atomically', async () => {
    const research = await card();
    const rate = async (rating: string) => {
      const response = await selfCheck(req('learning/self-check', { researchId: research.id, questionKey: 'q1', rating }));
      expect(response.status).toBe(200);
      return response.json();
    };
    expect((await rate('got_it')).firstMissedAt).toBeNull();
    expect((await rate('missed')).firstMissedAt).not.toBeNull();
    const first = new Date('2026-01-01T00:00:00Z');
    await db.learningSelfCheck.updateMany({ where: { researchId: research.id }, data: { firstMissedAt: first } });
    expect((await rate('unsure')).firstMissedAt).toBe(first.toISOString());
    expect((await rate('got_it')).firstMissedAt).toBeNull();
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => rate('missed')));
    expect(concurrent.every(row => row.firstMissedAt !== null)).toBe(true);
    expect(new Set(concurrent.map(row => row.firstMissedAt)).size).toBe(1);
    expect(await db.learningSelfCheck.count({ where: { researchId: research.id, userId: shared.actorId } })).toBe(1);
  });

  it('revises the judgement, indexes it and removes only the owner card from the due queue', async () => {
    const mine = await card();
    const other = await db.user.create({ data: { email: `other-review-${crypto.randomUUID()}@e2e.local`, name: 'Other review owner' } });
    const theirs = await card(other.id);
    const before = await getReviewQueueCounts(db, shared.actorId);
    const where = researchListWhere({ scope: 'mine', userId: shared.actorId, judgementDue: true });
    const rows = await db.research.findMany({ where });
    expect(rows.some(row => row.id === mine.id)).toBe(true);
    expect(rows.some(row => row.id === theirs.id)).toBe(false);
    expect(rows).toHaveLength(before.judgementDue);

    const revised = {
      action: 'revise', judgement: 'The revised claim has narrower support.', judgementConfidence: 'medium',
      judgementScope: 'Applies only to bounded production workloads.', judgementReviewAt: new Date(Date.now() + 86400000 * 30).toISOString(),
    };
    const response = await judgement(req(`researches/${mine.id}/judgement`, revised), { params: Promise.resolve({ id: mine.id }) });
    expect(response.status).toBe(200);
    const persisted = await db.research.findUniqueOrThrow({ where: { id: mine.id } });
    expect(persisted).toMatchObject({ status: 'published', judgement: revised.judgement, judgementConfidence: 'medium' });
    expect(persisted.knowledgeIndexText).toContain(revised.judgement);
    expect(persisted.knowledgeIndexText).toContain(revised.judgementScope);
    expect(await db.researchAudit.count({ where: { researchId: mine.id, action: 'edit' } })).toBe(1);
    expect(await db.personalKnowledgeIndexTask.findUnique({ where: { researchId: mine.id } })).toMatchObject({ status: 'queued', operation: 'upsert' });
    expect((await getReviewQueueCounts(db, shared.actorId)).judgementDue).toBe(before.judgementDue - 1);
    expect((await db.research.findUniqueOrThrow({ where: { id: theirs.id } })).judgementReviewAt).toEqual(theirs.judgementReviewAt);
  });
});
