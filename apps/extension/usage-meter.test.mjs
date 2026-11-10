import test from 'node:test';
import assert from 'node:assert/strict';

import {
  USAGE_KEY,
  mergeUsage,
  pruneUsage,
  recordUsage,
  usageDay,
  usageSummary,
} from './usage-meter.js';

const DAY = '2026-11-09';

test('usageDay formats a local calendar day and passes explicit days through', () => {
  assert.equal(usageDay(new Date(2026, 10, 9, 23, 59)), '2026-11-09');
  assert.equal(usageDay(new Date(2026, 0, 1, 0, 0)), '2026-01-01');
  // An explicit day string is already a local day; re-parsing it as UTC would
  // move it a day backwards west of Greenwich.
  assert.equal(usageDay('2026-11-09'), '2026-11-09');
  assert.equal(usageDay('2027-01-01'), '2027-01-01');
  assert.match(usageDay(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(usageDay(new Date(Number.NaN)), /^\d{4}-\d{2}-\d{2}$/, 'invalid dates fall back to today');
  assert.equal(usageDay('not-a-day'), usageDay(), 'unparseable strings fall back to today');
  assert.equal(USAGE_KEY, 'readerUsage');
});

test('recordUsage accumulates per day and per kind without mutating the input', () => {
  const first = recordUsage(null, { day: DAY, requests: 1, chars: 120, tokens: 90, kind: 'translation' });
  const second = recordUsage(first, { day: DAY, requests: 2, chars: 80, tokens: 40, kind: 'translation' });
  const answered = recordUsage(second, { day: DAY, requests: 1, chars: 30, tokens: 20, kind: 'answer' });
  const nextDay = recordUsage(answered, { day: '2026-11-10', requests: 1, chars: 10, tokens: 5 });

  assert.equal(first.days[DAY].translation.requests, 1, 'the previous object is untouched');
  assert.deepEqual(answered.days[DAY], {
    translation: { requests: 3, chars: 200, tokens: 130 },
    answer: { requests: 1, chars: 30, tokens: 20 },
  });
  assert.equal(nextDay.days[DAY].translation.requests, 3, 'another day does not disturb the first');
  assert.equal(nextDay.days['2026-11-10'].translation.chars, 10);
  assert.deepEqual(nextDay.totals.translation, { requests: 4, chars: 210, tokens: 135 }, 'totals span every day');
  assert.deepEqual(nextDay.totals.answer, { requests: 1, chars: 30, tokens: 20 });
});

test('recordUsage normalizes junk instead of corrupting the meter', () => {
  const usage = recordUsage(null, { day: DAY, requests: '2.6', chars: '-40', tokens: null });
  assert.deepEqual(usage.days[DAY].translation, { requests: 3, chars: 0, tokens: 0 });
  assert.deepEqual(usage.days[DAY].answer, undefined, 'untouched kinds stay absent');

  const nullUsage = recordUsage(null, {});
  assert.deepEqual(nullUsage.days, {}, 'a zero event does not create a day row');

  const badDay = recordUsage(null, { day: '2026-02-31', requests: 1 });
  assert.deepEqual(Object.keys(badDay.days), [usageDay()], 'impossible calendar days collapse to today');

  const unknownKind = recordUsage(null, { day: DAY, requests: 5, kind: 'image' });
  assert.deepEqual(unknownKind.days, {}, 'an unknown kind is never silently misfiled as translation');

  assert.deepEqual(recordUsage(null, null).days, {}, 'a null event is a no-op, not a crash');
  assert.deepEqual(recordUsage(recordUsage(null, { day: DAY, requests: 1 }), null).days[DAY].translation.requests, 1, 'a null event keeps the meter intact');
});

test('usageSummary sums a closed day range and filters by kind', () => {
  const usage = [
    { day: '2026-11-01', requests: 1, chars: 100, tokens: 60, kind: 'translation' },
    { day: '2026-11-02', requests: 2, chars: 200, tokens: 100, kind: 'translation' },
    { day: '2026-11-03', requests: 1, chars: 50, tokens: 25, kind: 'answer' },
    { day: '2026-11-09', requests: 4, chars: 400, tokens: 210, kind: 'translation' },
  ].reduce((meter, event) => recordUsage(meter, event), null);

  assert.deepEqual(usageSummary(usage, { from: '2026-11-02', to: '2026-11-02' }), { requests: 2, chars: 200, tokens: 100, days: 1 }, 'both bounds are inclusive');
  assert.deepEqual(usageSummary(usage, { from: '2026-11-02', to: '2026-11-03' }), { requests: 3, chars: 250, tokens: 125, days: 2 });
  assert.deepEqual(usageSummary(usage, { from: '2026-11-02' }), { requests: 7, chars: 650, tokens: 335, days: 3 });
  assert.deepEqual(usageSummary(usage, { to: '2026-11-01' }), { requests: 1, chars: 100, tokens: 60, days: 1 });
  assert.deepEqual(usageSummary(usage, { from: '2026-11-04', to: '2026-11-08' }), { requests: 0, chars: 0, tokens: 0, days: 0 }, 'a range with no data is zero, not undefined');
  assert.deepEqual(usageSummary(usage, { from: '2026-11-02', to: '2026-11-03', kind: 'answer' }), { requests: 1, chars: 50, tokens: 25, days: 1 });
  assert.deepEqual(usageSummary(usage, { kind: 'answer' }), { requests: 1, chars: 50, tokens: 25, days: 1 });
  assert.deepEqual(usageSummary(usage), { requests: 8, chars: 750, tokens: 395, days: 4 }, 'no filter means everything');

  assert.deepEqual(usageSummary(usage, { from: 'garbage', to: -1 }), { requests: 8, chars: 750, tokens: 395, days: 4 }, 'bad bounds are ignored rather than hiding real usage');
  assert.deepEqual(usageSummary(null), { requests: 0, chars: 0, tokens: 0, days: 0 });
  assert.deepEqual(usageSummary(usage, null), { requests: 8, chars: 750, tokens: 395, days: 4 }, 'a null filter means no filter');
  assert.deepEqual(usageSummary(usage, { kind: 'image' }), { requests: 8, chars: 750, tokens: 395, days: 4 }, 'an unknown kind filter never hides real usage');
});

test('mergeUsage is an idempotent union that never adds duplicates', () => {
  const panelA = recordUsage(null, { day: '2026-11-08', requests: 2, chars: 200, tokens: 100 });
  const panelB = recordUsage(null, { day: '2026-11-09', requests: 1, chars: 50, tokens: 20, kind: 'answer' });

  assert.deepEqual(mergeUsage(panelA, panelA), panelA, 'merge(a, a) does not double count');
  const both = mergeUsage(panelA, panelB);
  assert.equal(both.days['2026-11-08'].translation.requests, 2);
  assert.equal(both.days['2026-11-09'].answer.requests, 1);
  assert.deepEqual(both.totals.translation, { requests: 2, chars: 200, tokens: 100 });
  assert.deepEqual(mergeUsage(panelB, panelA), both, 'merge is symmetric');

  // Same day, same kind: the larger value wins per counter, so two panels that
  // both observed the same batch cannot describe it twice.
  const full = recordUsage(null, { day: '2026-11-08', requests: 2, chars: 200, tokens: 100 });
  const stale = recordUsage(null, { day: '2026-11-08', requests: 1, chars: 200, tokens: 0 });
  assert.deepEqual(mergeUsage(full, stale).days['2026-11-08'].translation, { requests: 2, chars: 200, tokens: 100 });
  assert.deepEqual(mergeUsage(stale, full).days['2026-11-08'].translation, { requests: 2, chars: 200, tokens: 100 });
  assert.equal(mergeUsage(full, null).days['2026-11-08'].translation.requests, 2);
  assert.equal(mergeUsage(null, null).totals.translation.requests, 0);
});

test('pruneUsage keeps the recent window and today', () => {
  const usage = [
    { day: '2026-11-01', requests: 1 },
    { day: '2026-11-07', requests: 1 },
    { day: '2026-11-08', requests: 1 },
    { day: '2026-11-09', requests: 1 },
    { day: '2026-11-20', requests: 1 },
  ].reduce((meter, event) => recordUsage(meter, event), null);

  const twoDays = pruneUsage(usage, { keepDays: 2, today: '2026-11-09' });
  assert.deepEqual(Object.keys(twoDays.days).sort(), ['2026-11-08', '2026-11-09', '2026-11-20'], 'today and yesterday survive; a future day is not data loss');
  assert.deepEqual(twoDays.totals.translation, { requests: 3, chars: 0, tokens: 0 }, 'totals follow the pruned days');
  assert.equal(Object.keys(usage.days).length, 5, 'the input is untouched');

  assert.deepEqual(Object.keys(pruneUsage(usage, { keepDays: 1, today: '2026-11-09' }).days).sort(), ['2026-11-09', '2026-11-20']);
  assert.equal(Object.keys(pruneUsage(usage, { keepDays: 120, today: '2026-11-09' }).days).length, 5);
  assert.equal(Object.keys(pruneUsage(usage, { keepDays: 0, today: '2026-11-09' }).days).length, 5, 'an out-of-range keepDays falls back to the default window');
  assert.equal(Object.keys(pruneUsage(usage, { today: '2026-11-09' }).days).length, 5, 'default keepDays is 120');
  assert.deepEqual(pruneUsage(null).days, {});
  assert.deepEqual(pruneUsage(usage, null).days, usage.days, 'a null window keeps everything instead of deleting data');
});

test('usage records only counters and survives unknown shapes', () => {
  const dirty = {
    days: {
      '2026-11-09': {
        translation: { requests: 2, chars: 100, tokens: 40, body: 'secret page text', url: 'https://example.com' },
        answer: { requests: 1, chars: 10, tokens: 5, apiKey: 'sk-secret' },
        image: { requests: 9 },
      },
      'not-a-day': { translation: { requests: 99 } },
      '2026-13-01': { translation: { requests: 99 } },
    },
    totals: { translation: { requests: 999, chars: 999, tokens: 999 } },
    url: 'https://example.com/private',
    apiKey: 'sk-secret',
    model: 'gpt-4o',
  };
  const usage = recordUsage(dirty, { day: DAY, requests: 1, chars: 5, tokens: 5 });

  assert.deepEqual(Object.keys(usage).sort(), ['days', 'totals'], 'no top-level metadata survives');
  assert.deepEqual(Object.keys(usage.days).sort(), ['2026-11-09']);
  assert.deepEqual(Object.keys(usage.days[DAY]).sort(), ['answer', 'translation'], 'unknown kinds are dropped');
  for (const entry of Object.values(usage.days[DAY])) {
    assert.deepEqual(Object.keys(entry).sort(), ['chars', 'requests', 'tokens'], 'a day entry is counters only');
    for (const value of Object.values(entry)) assert.equal(typeof value, 'number');
  }
  assert.deepEqual(usage.days[DAY].translation, { requests: 3, chars: 105, tokens: 45 });
  assert.deepEqual(usage.totals.translation, { requests: 3, chars: 105, tokens: 45 }, 'a stale totals cache is recomputed');
  assert.doesNotMatch(JSON.stringify(usage), /secret|example\.com|gpt-4o/, 'nothing identifying is persisted');

  assert.deepEqual(usageSummary(dirty, { from: '2026-11-01', to: '2026-12-01' }), { requests: 3, chars: 110, tokens: 45, days: 1 });
  assert.deepEqual(recordUsage('not an object', { day: DAY, requests: 1 }).days[DAY].translation, { requests: 1, chars: 0, tokens: 0 });
});
