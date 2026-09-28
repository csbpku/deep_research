import { describe, expect, it } from 'vitest';

import { buildSearchSql } from './query';

describe('buildSearchSql', () => {
  it('includes external-reading candidates without searching or returning cached body text', () => {
    const { rowsSql } = buildSearchSql({
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
  });
});
