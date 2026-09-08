import { describe, expect, it } from 'vitest';

import { buildWeeklyProductEventDedupeKey, isoWeekOf } from './product-events';

describe('product event weekly dedupe keys', () => {
  it('uses the ISO week year at a calendar-year boundary', () => {
    expect(isoWeekOf(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(isoWeekOf(new Date('2027-01-04T12:00:00Z'))).toBe('2027-W01');
  });

  it('keeps different event types independent while deduping repeated opens', () => {
    const input = {
      userId: 'user-1',
      targetType: 'research',
      targetId: 'research-1',
      date: new Date('2026-09-03T12:00:00Z'),
    };
    const opened = buildWeeklyProductEventDedupeKey({
      ...input,
      eventType: 'research_draft_opened',
    });
    const reopened = buildWeeklyProductEventDedupeKey({
      ...input,
      eventType: 'research_reopened_from_topic',
    });

    expect(opened).toBe('user-1:research_draft_opened:research:research-1:2026-W36');
    expect(buildWeeklyProductEventDedupeKey({
      ...input,
      eventType: 'research_draft_opened',
    })).toBe(opened);
    expect(reopened).not.toBe(opened);
  });
});
