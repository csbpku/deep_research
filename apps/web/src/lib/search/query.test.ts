import { describe, expect, it } from 'vitest';

import { buildSearchSql } from './query';
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
