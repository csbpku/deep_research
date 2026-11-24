import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSearchSql } from './query';
import { hasPublicRadarReview } from '../radar/visibility';

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/pr56_publication_test') {
    throw new Error('Radar search integration tests require the isolated localhost pr56_publication_test database');
  }
}
let db: PrismaClient;
let runId: string;

describe.skipIf(!testUrl)('radar search visibility and redaction on PostgreSQL', () => {
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: testUrl! } } });
    const source = await db.radarSource.create({ data: { name: 'PR search regression', sourceType: 'rss', config: {}, enabled: false } });
    const run = await db.radarSyncRun.create({ data: { sourceId: source.id, triggeredBy: 'admin', status: 'completed' } });
    runId = run.id;
  });
  afterAll(async () => { await db?.$disconnect(); });

  it.each([
    { contentReviewStatus: null, renderReviewStatus: null, interpretation: 'A safe public explanation' },
    { contentReviewStatus: null, renderReviewStatus: null, interpretation: '' },
    { contentReviewStatus: 'needs_manual_review', renderReviewStatus: 'approved', interpretation: '' },
    { contentReviewStatus: 'needs_manual_review', renderReviewStatus: 'needs_manual_review', interpretation: '' },
    { contentReviewStatus: 'reviewing', renderReviewStatus: 'approved', interpretation: '' },
    { contentReviewStatus: 'approved', renderReviewStatus: 'approved', interpretation: '' },
  ])('matches the summary gate without leaking cached content: %j', async (review) => {
    const title = `public${randomUUID().replaceAll('-', '')}`;
    const secret = `secret${randomUUID().replaceAll('-', '')}`;
    const url = `https://example.com/${randomUUID()}`;
    const row = await db.summary.create({ data: {
      title, body: secret, url, canonicalUrl: url, source: 'daily', summaryDate: new Date(), syncRunId: runId,
      originalKind: 'rss', originalMeta: { enrichmentVersion: '2.0' },
      distilledTier: 'deep_read', distilledScore: {
        isDefault: false, tier: 'deep_read', total: 80, profile: 'engineering', version: 'v2',
        dimensions: { informationGain: 2, analysisDepth: 2, actionability: 2, factualReliability: 2,
          currentApplicability: 2, expressionQuality: 2, audienceFit: 2 },
      },
      enrichmentStatus: 'ready', readerQualityStatus: 'ready', ...review,
    } });
    expect(row.distilledTier).toBe('deep_read');
    expect(row.enrichmentStatus).toBe('ready');
    const search = async (q: string) => {
      const query = buildSearchSql({ q, type: 'radar', page: 1, perPage: 100 });
      const rows = await db.$queryRawUnsafe<Array<{ refId: string; snippet: string; highlighted: string }>>(query.rowsSql, ...query.params);
      const count = await db.$queryRawUnsafe<Array<{ total: number }>>(query.countSql, ...query.params.slice(0, 3));
      expect(count[0].total).toBe(rows.length);
      return rows.find(result => result.refId === row.id);
    };
    const result = await search(title);
    expect(Boolean(result)).toBe(hasPublicRadarReview(row));
    if (review.contentReviewStatus !== 'approved') {
      expect(JSON.stringify(result) ?? '').not.toContain(secret);
      expect(await search(secret)).toBeUndefined();
    } else {
      expect(result?.snippet).toContain(secret);
      expect(await search(secret)).toBeDefined();
    }
  });
});
