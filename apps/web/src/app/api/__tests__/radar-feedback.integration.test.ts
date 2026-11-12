import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import { validRadarScore } from '@/lib/radar/test-score';
import type { Prisma } from '@prisma/client';

// Opt in only against this dedicated, local database after applying the Prisma
// schema. DATABASE_URL must match, so importing the production singleton cannot
// accidentally connect to a different database.
const dbUrl = process.env.RADAR_FEEDBACK_TEST_DATABASE_URL;
const allowed = (() => {
  if (!dbUrl || process.env.DATABASE_URL !== dbUrl) return false;
  try {
    const url = new URL(dbUrl);
    return url.hostname === '127.0.0.1' && url.pathname === '/deep_research_radar_feedback_test';
  } catch { return false; }
})();
if (dbUrl && !allowed) throw new Error('Radar feedback integration tests require the isolated local test database');

vi.mock('@/lib/auth/session', () => ({
  requireUser: async (req: Request) => ({ id: req.headers.get('x-test-user-id'), role: 'member' }),
}));

let prisma: typeof import('@/lib/db').prisma;
let POST: typeof import('../radar-feedback/route').POST;
let DELETE: typeof import('../radar-feedback/route').DELETE;
let summaryId: string;
let sourceId: string;
let runId: string;
const userIds: string[] = [];

const request = (method: 'POST' | 'DELETE', userId: string, feedbackType: RadarFeedbackType) => new Request(
  method === 'POST' ? 'http://localhost/api/radar-feedback'
    : `http://localhost/api/radar-feedback?summaryId=${summaryId}&feedbackType=${feedbackType}`,
  {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user-id': userId },
    ...(method === 'POST' ? { body: JSON.stringify({ summaryId, feedbackType }) } : {}),
  },
) as never;

describe.skipIf(!allowed)('radar feedback handlers on isolated PostgreSQL', () => {
  beforeAll(async () => {
    ({ prisma } = await import('@/lib/db'));
    ({ POST, DELETE } = await import('../radar-feedback/route'));
    for (let i = 0; i < 6; i++) {
      const user = await prisma.user.create({ data: { email: `radar-feedback-${crypto.randomUUID()}@e2e.local`, name: 'Feedback test' } });
      userIds.push(user.id);
    }
    const source = await prisma.radarSource.create({ data: { name: `feedback-${crypto.randomUUID()}`, sourceType: 'rss', config: {} } });
    sourceId = source.id;
    const run = await prisma.radarSyncRun.create({ data: { sourceId, triggeredBy: 'admin' } });
    runId = run.id;
    const url = `https://example.com/feedback-${crypto.randomUUID()}`;
    const summary = await prisma.summary.create({ data: {
      title: 'Feedback integration fixture', body: 'Public summary', url, canonicalUrl: url,
      source: 'daily', summaryDate: new Date(), syncRunId: runId,
      distilledScore: validRadarScore as unknown as Prisma.InputJsonValue, distilledTier: 'deep_read',
      enrichmentStatus: 'ready', readerQualityStatus: 'ready', contentReviewStatus: 'approved',
    } });
    summaryId = summary.id;
  });

  afterAll(async () => {
    // Delete only fixture records, never truncate a shared table.
    if (summaryId) {
      await prisma.userBookmark.deleteMany({ where: { targetId: summaryId, userId: { in: userIds } } });
      await prisma.summary.delete({ where: { id: summaryId } });
    }
    if (runId) await prisma.radarSyncRun.delete({ where: { id: runId } });
    if (sourceId) await prisma.radarSource.delete({ where: { id: sourceId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it('commits idempotent judgments and reverses the persisted aggregate on DELETE', async () => {
    const created = await POST(request('POST', userIds[0], 'pilot'));
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ created: true, judgmentScore: 2, feedbackCounts: { pilot: 1 } });
    const duplicate = await POST(request('POST', userIds[0], 'pilot'));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ created: false, judgmentScore: 2 });
    expect(await prisma.radarFeedback.count({ where: { summaryId } })).toBe(1);
    expect((await prisma.summary.findUniqueOrThrow({ where: { id: summaryId } })).judgmentScore).toBe(2);

    const deleted = await DELETE(request('DELETE', userIds[0], 'pilot'));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ removed: 1, judgmentScore: 0, feedbackCounts: { pilot: 0 } });
    const absent = await DELETE(request('DELETE', userIds[0], 'pilot'));
    expect(absent.status).toBe(200);
    expect(await absent.json()).toMatchObject({ removed: 0, judgmentScore: 0 });
    expect((await prisma.summary.findUniqueOrThrow({ where: { id: summaryId } })).judgmentScore).toBe(0);
  });

  it('keeps favorite and bookmark records atomic through POST and DELETE', async () => {
    const added = await POST(request('POST', userIds[0], 'favorite'));
    expect(added.status).toBe(200);
    expect(await prisma.userBookmark.count({ where: { userId: userIds[0], targetId: summaryId } })).toBe(1);
    const removed = await DELETE(request('DELETE', userIds[0], 'favorite'));
    expect(removed.status).toBe(200);
    expect(await prisma.userBookmark.count({ where: { userId: userIds[0], targetId: summaryId } })).toBe(0);
    expect(await prisma.radarFeedback.count({ where: { summaryId, feedbackType: 'favorite' } })).toBe(0);
  });

  it('serializes concurrent writes, duplicates and removals without losing aggregate updates', async () => {
    const types: RadarFeedbackType[] = ['pilot', 'pilot', 'later', 'later', 'read', 'inaccurate'];
    const added = await Promise.all(types.flatMap((type, i) => [
      POST(request('POST', userIds[i], type)), POST(request('POST', userIds[i], type)),
    ]));
    expect(added.map((response) => response.status)).toEqual(Array(12).fill(200));
    expect(await prisma.radarFeedback.count({ where: { summaryId } })).toBe(6);
    expect((await prisma.summary.findUniqueOrThrow({ where: { id: summaryId } })).judgmentScore).toBe(3);

    const changed = await Promise.all([
      DELETE(request('DELETE', userIds[0], 'pilot')),
      DELETE(request('DELETE', userIds[1], 'pilot')),
      POST(request('POST', userIds[0], 'read')),
      POST(request('POST', userIds[1], 'later')),
    ]);
    expect(changed.map((response) => response.status)).toEqual(Array(4).fill(200));
    const groups = await prisma.radarFeedback.groupBy({ by: ['feedbackType'], where: { summaryId }, _count: { feedbackType: true } });
    expect(groups).toEqual(expect.arrayContaining([
      { feedbackType: 'later', _count: { feedbackType: 3 } },
      { feedbackType: 'read', _count: { feedbackType: 2 } },
      { feedbackType: 'inaccurate', _count: { feedbackType: 1 } },
    ]));
    expect((await prisma.summary.findUniqueOrThrow({ where: { id: summaryId } })).judgmentScore).toBe(-1);
  });
});
