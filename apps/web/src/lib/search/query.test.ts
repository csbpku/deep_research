import { describe, expect, it } from 'vitest';

import { buildSearchSql, shapeSearchRow } from './query';
import { RADAR_PUBLIC_SCORE_SQL } from '../radar/score-validity';

describe('buildSearchSql', () => {
  it('includes external-reading candidates without searching or returning cached body text', () => {
    const { rowsSql, countSql } = buildSearchSql({
      q: 'repository',
      type: 'radar',
      userId: null,
      page: 1,
      perPage: 20,
    });

    expect(rowsSql).toContain("'external_reading' = ANY(COALESCE(s.tags, ARRAY[]::text[]))");
    expect(rowsSql).toContain("THEN LEFT(COALESCE(NULLIF(s.interpretation, ''), ''), 1000)");
    expect(rowsSql).toContain("THEN '' ELSE COALESCE(s.body, '') END");
    expect(rowsSql).toContain('s."readerQualityStatus" = \'ready\'');
    expect(rowsSql).toContain('s."contentReviewStatus" = \'approved\'');
    expect(rowsSql).toContain(RADAR_PUBLIC_SCORE_SQL);
    expect(countSql).toContain(RADAR_PUBLIC_SCORE_SQL);
  });
});

describe('buildSearchSql judgement ranking', () => {
  it('adds a judgement boost for knowledge results only', () => {
    const { rowsSql } = buildSearchSql({ q: '调用关系', page: 1, perPage: 20 });
    expect(rowsSql).toContain('AS boost');
    expect(rowsSql).toContain("type = 'knowledge'");
    expect(rowsSql).toContain("r2.judgement IS NOT NULL");
    expect(rowsSql).toContain('ORDER BY (rank + boost) DESC');
  });
});

describe('buildSearchSql judgement highlight', () => {
  it('selects a judgement headline for knowledge matches', () => {
    const { rowsSql } = buildSearchSql({ q: '调用关系', page: 1, perPage: 20 });
    expect(rowsSql).toContain('"judgementMatch"');
    expect(rowsSql).toContain('left(r2.judgement');
    expect(rowsSql).toContain('r2.judgement');
  });
});

describe('shapeSearchRow match reasons', () => {
  const base = {
    id: 'a', type: 'knowledge', refId: 'r1', title: 't', snippet: 's',
    highlighted: '', publishedAt: new Date(), rank: 1,
  };
  it('prefers judgement, then title, then tag', () => {
    expect(shapeSearchRow({ ...base, judgementMatch: 'j' }).matchReason).toBe('judgement');
    expect(shapeSearchRow({ ...base, titleMatch: true }).matchReason).toBe('title');
    expect(shapeSearchRow({ ...base, tagMatch: true }).matchReason).toBe('tag');
    expect(shapeSearchRow(base).matchReason).toBeNull();
  });
});

describe('shapeSearchRow multiple match reasons', () => {
  it('keeps every reason in priority order', () => {
    const shaped = shapeSearchRow({
      id: 'radar:1', type: 'radar', refId: 'r1', title: 'PostgreSQL',
      snippet: 's', highlighted: '', publishedAt: new Date(), rank: 1,
      judgementMatch: 'j', titleMatch: true, tagMatch: true,
    });
    expect(shaped.matchReasons).toEqual(['judgement', 'title', 'tag']);
    expect(shaped.matchReason).toBe('judgement');
  });

  it('returns an empty reason list for a body-only match', () => {
    const shaped = shapeSearchRow({
      id: 'radar:1', type: 'radar', refId: 'r1', title: 'x',
      snippet: 's', highlighted: '<mark>s</mark>', publishedAt: new Date(), rank: 1,
    });
    expect(shaped.matchReasons).toEqual([]);
    expect(shaped.matchReason).toBeNull();
  });
});

describe('shapeSearchRow judgement preview', () => {
  it('returns a trimmed body preview next to the judgement match', () => {
    const shaped = shapeSearchRow({
      id: 'private:1', type: 'knowledge', refId: 'r1', title: 'Card',
      snippet: 'j', highlighted: '', publishedAt: new Date(), rank: 1,
      judgementMatch: 'j', bodyPreview: '  正文  ',
    });
    expect(shaped.bodyPreview).toBe('正文');
  });
});

describe('shapeSearchRow judgement context', () => {
  it('returns the confidence and scope beside a judgement match', () => {
    const shaped = shapeSearchRow({
      id: 'private:1', type: 'knowledge', refId: 'r1', title: 'Card',
      snippet: 'j', highlighted: '', publishedAt: new Date(), rank: 1,
      judgementMatch: 'j', judgementConfidence: 'high', judgementScope: ' 单库 ',
    });
    expect(shaped.judgementConfidence).toBe('high');
    expect(shaped.judgementScope).toBe('单库');
  });
});
