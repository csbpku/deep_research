// Local-only usage accounting for Reader (BYOK).
//
// People who pay their own API bill want to know "how much did I use this
// month?" without an account, a server or a telemetry endpoint. This module
// therefore only ever deals in counters: no page text, no URLs, no API keys,
// no provider names, no model ids. Keeping the shape narrow protects privacy
// and makes imports and usage-snapshot merges predictable.
//
// Everything is pure: the caller owns chrome.storage (or anything else) and
// passes plain objects in and out. `days` is the source of truth; `totals` is a
// derived convenience cache recomputed on every write so an incremental update
// can never drift from the per-day rows.

export const USAGE_KEY = 'readerUsage';

const KINDS = ['translation', 'answer'];
const COUNTERS = ['requests', 'chars', 'tokens'];
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function emptyCounters() {
  return { requests: 0, chars: 0, tokens: 0 };
}

// Number() throws on symbols; a corrupted storage blob must degrade to a zero
// counter instead of crashing the panel that renders it.
function numeric(value) {
  if (typeof value === 'symbol') return Number.NaN;
  try {
    return Number(value);
  } catch {
    return Number.NaN;
  }
}

// Usage is a counter, not a measurement: NaN, negative numbers and numeric
// junk from corrupted storage must become 0 instead of poisoning every total
// that is computed from them later.
function counter(value) {
  const number = numeric(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function normalizeKind(kind) {
  const value = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
  return KINDS.includes(value) ? value : '';
}

function calendarDay(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  // Reject "2026-02-31" style keys instead of letting Date roll them forward.
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeDayKey(value) {
  if (typeof value !== 'string') return null;
  const match = DAY_PATTERN.exec(value.trim());
  if (!match) return null;
  return calendarDay(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** Local-timezone calendar day as 'YYYY-MM-DD'. Strings already in that form pass through unchanged. */
export function usageDay(date = new Date()) {
  if (typeof date === 'string') {
    const exact = normalizeDayKey(date);
    // '2026-11-09' parsed as UTC can land on the previous local day west of
    // Greenwich; treating an explicit day string as already-local avoids that.
    if (exact) return exact;
  }
  const now = new Date();
  // Only numbers and strings can construct a Date; anything else (symbols,
  // functions, plain objects) is a caller bug that must read as "today".
  const usable = date instanceof Date || typeof date === 'number' || typeof date === 'string';
  let value = date instanceof Date ? date : usable ? new Date(date) : now;
  if (Number.isNaN(value.getTime())) value = now;
  return calendarDay(value.getFullYear(), value.getMonth() + 1, value.getDate())
    || calendarDay(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function totalsOf(days) {
  const totals = {};
  for (const kind of KINDS) {
    totals[kind] = emptyCounters();
    for (const entry of Object.values(days)) {
      const counters = entry[kind];
      if (!counters) continue;
      for (const field of COUNTERS) totals[kind][field] += counters[field];
    }
  }
  return totals;
}

// Field-wise max merge of one day. Used both when importing (two spellings of
// the same day key) and when merging snapshots: keeping the larger evidence is
// what makes merge idempotent.
function mergeDay(days, day, entry) {
  const merged = { ...(days[day] || {}) };
  for (const kind of KINDS) {
    const mine = merged[kind];
    const theirs = entry[kind];
    // A day that exists only on one side is copied, not "merged" with zero:
    // zero-filling would turn a legitimate count into a max() against 0 and
    // silently drop the only evidence there is.
    if (!mine) {
      if (theirs) merged[kind] = { ...theirs };
      continue;
    }
    if (!theirs) continue;
    // Field-wise max keeps the best evidence per counter; a panel that only
    // knows characters cannot erase the token count recorded elsewhere.
    merged[kind] = {
      requests: Math.max(mine.requests, theirs.requests),
      chars: Math.max(mine.chars, theirs.chars),
      tokens: Math.max(mine.tokens, theirs.tokens),
    };
  }
  days[day] = merged;
}

// Rebuild a clean, minimal usage object: invalid days are dropped, unknown
// kinds are dropped, and anything that is not a counter (text, url, apiKey,
// model, whatever a future caller stuffs in) is stripped before it can be
// persisted or synced.
function normalizeUsage(usage) {
  const days = {};
  const sourceDays = usage && typeof usage === 'object' && usage.days && typeof usage.days === 'object' ? usage.days : {};
  for (const [key, entry] of Object.entries(sourceDays)) {
    const day = normalizeDayKey(key);
    if (!day || !entry || typeof entry !== 'object') continue;
    const target = {};
    for (const kind of KINDS) {
      const counters = entry[kind];
      if (!counters || typeof counters !== 'object') continue;
      target[kind] = { requests: counter(counters.requests), chars: counter(counters.chars), tokens: counter(counters.tokens) };
    }
    if (Object.keys(target).length) mergeDay(days, day, target);
  }
  return { days, totals: totalsOf(days) };
}

/**
 * Add one finished request to the meter. Returns a new usage object; the input
 * is never mutated, so a failed storage write cannot leave a half-updated meter.
 * @param {object} usage previous usage (may be null/partial)
 * @param {{ day?: string, requests?: number, chars?: number, tokens?: number, kind?: 'translation'|'answer' }} [event]
 */
export function recordUsage(usage, event = {}) {
  // Guard instead of destructuring: a null event from a half-wired caller must
  // be a no-op edit, not a thrown exception inside a storage write.
  const input = event && typeof event === 'object' ? event : {};
  const day = input.day;
  const requests = counter(input.requests);
  const chars = counter(input.chars);
  const tokens = counter(input.tokens);
  const kind = input.kind === undefined ? 'translation' : input.kind;
  const base = normalizeUsage(usage);
  const targetKind = normalizeKind(kind);
  // An unknown kind is a programming error, not a third category: silently
  // filing it under 'translation' would corrupt the numbers it is meant to
  // measure, so the meter stays unchanged instead of guessing.
  if (!targetKind) return base;
  const targetDay = normalizeDayKey(day) || usageDay();
  const previous = base.days[targetDay]?.[targetKind];
  // Recording nothing must not create a day row: "days with usage" is a number
  // people read in the UI, and an empty row would inflate it.
  if (!previous && !requests && !chars && !tokens) return base;
  const next = {
    ...base.days[targetDay],
    [targetKind]: {
      requests: counter((previous?.requests || 0) + requests),
      chars: counter((previous?.chars || 0) + chars),
      tokens: counter((previous?.tokens || 0) + tokens),
    },
  };
  return { days: { ...base.days, [targetDay]: next }, totals: totalsOf({ ...base.days, [targetDay]: next }) };
}

/**
 * Sum the meter over a closed day range ('YYYY-MM-DD' inclusive).
 * @param {object} usage
 * @param {{ from?: string, to?: string, kind?: 'translation'|'answer' }} [range]
 * @returns {{ requests: number, chars: number, tokens: number, days: number }}
 */
export function usageSummary(usage, range = {}) {
  const filter = range && typeof range === 'object' ? range : {};
  const { from, to, kind } = filter;
  const base = normalizeUsage(usage);
  const requestedKind = kind === undefined || kind === null || kind === '' ? '' : normalizeKind(kind);
  // An invalid bound is ignored rather than turned into an empty range: a
  // mangled filter should show lifetime numbers, never a false "0 requests".
  const start = normalizeDayKey(from);
  const end = normalizeDayKey(to);
  const summary = { requests: 0, chars: 0, tokens: 0, days: 0 };
  for (const [day, entry] of Object.entries(base.days)) {
    if (start && day < start) continue;
    if (end && day > end) continue;
    const kinds = requestedKind ? [requestedKind] : KINDS;
    let matched = false;
    let requests = 0;
    let chars = 0;
    let tokens = 0;
    for (const name of kinds) {
      const counters = entry[name];
      if (!counters) continue;
      matched = true;
      requests += counters.requests;
      chars += counters.chars;
      tokens += counters.tokens;
    }
    if (!matched) continue;
    // Count only days that actually used something; an all-zero row is not a
    // day the user would recognise as usage.
    if (!requests && !chars && !tokens) continue;
    summary.days += 1;
    summary.requests += requests;
    summary.chars += chars;
    summary.tokens += tokens;
  }
  return summary;
}

/**
 * Merge cumulative snapshots without counting the same history twice. Per
 * day and kind the larger value wins: merge(a, a) is a no-op. Independent
 * finished requests are deltas, not snapshots; persist those through the
 * shared usage recorder so concurrent read-modify-write calls cannot lose
 * increments.
 */
export function mergeUsage(a, b) {
  const left = normalizeUsage(a);
  const right = normalizeUsage(b);
  const days = { ...left.days };
  for (const [day, entry] of Object.entries(right.days)) mergeDay(days, day, entry);
  return { days, totals: totalsOf(days) };
}

function shiftDay(day, offset) {
  const match = DAY_PATTERN.exec(day);
  if (!match) return day;
  // Local Date arithmetic (not fixed 86400000 ms) so DST transitions cannot
  // shift the retention cutoff by an hour and drop a day too many.
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offset);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Keep the most recent `keepDays` calendar days, today included. Returns a new
 * usage object; totals are recomputed so the trimmed meter stays consistent.
 */
export function pruneUsage(usage, window = {}) {
  const options = window && typeof window === 'object' ? window : {};
  const keepDays = options.keepDays === undefined ? 120 : options.keepDays;
  const today = options.today === undefined ? new Date() : options.today;
  const base = normalizeUsage(usage);
  const requested = Math.floor(numeric(keepDays));
  const daysToKeep = Number.isFinite(requested) && requested >= 1 ? Math.min(requested, 10_000) : 120;
  const cutoff = shiftDay(usageDay(today), -(daysToKeep - 1));
  const days = {};
  for (const [day, entry] of Object.entries(base.days)) {
    // String comparison is safe for zero-padded ISO day keys. Future days are
    // kept: a clock skew must not silently delete data the user just earned.
    if (day >= cutoff) days[day] = entry;
  }
  return { days, totals: totalsOf(days) };
}
