export const LIBRARY_PAGE_SIZE = 12;

/**
 * One normalisation contract for query, tags and sites: NFKC folds full-width
 * text typed on CJK keyboards, and case folding keeps "React"/"react" together.
 * Every filter goes through this helper so no two of them disagree about what
 * counts as the same value.
 */
function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase();
}

/** First non-blank string wins; used for the documented field fallbacks. */
function firstText(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value;
  return '';
}

/** Hostname only: two articles on one site must share a facet but not a page group. */
function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return '';
  }
}

/**
 * Tags keep their original casing because they are shown back to the reader,
 * while de-duplication stays case-insensitive so ["React", "react"] cannot
 * produce two identical-looking export lines or facet rows.
 */
function tagsOf(record) {
  const seen = new Set();
  const tags = [];
  for (const tag of Array.isArray(record?.tags) ? record.tags : []) {
    if (typeof tag !== 'string') continue;
    const value = tag.trim();
    if (!value) continue;
    const key = normalizeText(value);
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(value);
  }
  return tags;
}

/**
 * Two storage shapes (insight / annotation) become one view model so callers
 * never have to remember that annotations keep the quote under anchor.quote and
 * the page under document.url. Exported so a single record (a detail view, an
 * export of one entry) can be normalised without rebuilding a collection.
 */
export function libraryItem(kind, record) {
  const insight = kind === 'insight';
  const url = insight ? firstText(record?.url, record?.document?.url) : firstText(record?.document?.url, record?.url);
  return {
    kind,
    id: record?.id,
    url,
    site: hostnameOf(url),
    title: firstText(record?.document?.title, record?.title),
    quote: insight
      ? firstText(record?.quote, record?.anchor?.quote)
      : firstText(record?.anchor?.quote, record?.quote),
    note: firstText(record?.note),
    aiAnswer: firstText(record?.aiAnswer),
    tags: tagsOf(record),
    // Imports may carry only one of the two timestamps; falling back keeps
    // sorting and month facets stable for those legacy records.
    updatedAt: firstText(record?.updatedAt) || firstText(record?.createdAt),
    createdAt: firstText(record?.createdAt) || firstText(record?.updatedAt),
  };
}

/** Local calendar month: a save at 00:30 local time belongs to that local month. */
function monthOf(value) {
  const time = timestampOf(value);
  if (Number.isNaN(time)) return '';
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function timestampOf(value) {
  return Date.parse(String(value ?? ''));
}

/**
 * Accept either the flat view model or a `{ kind, record }` entry as returned by
 * libraryPage(). Consumers should not have to know which one they hold, and the
 * wrong guess would render blank rows instead of failing loudly.
 */
export function libraryEntry(item) {
  if (item && item.record && typeof item.record === 'object') {
    return libraryItem(item.kind === 'annotation' ? 'annotation' : 'insight', item.record);
  }
  return item;
}

/** Insights first, then annotations: the order the panel has always listed them in. */
export function libraryItems(insights, annotations) {
  return [
    ...(Array.isArray(insights) ? insights : []).map(record => libraryItem('insight', record)),
    ...(Array.isArray(annotations) ? annotations : []).map(record => libraryItem('annotation', record)),
  ];
}

/**
 * Facets describe the *whole* collection (not the current page) so the UI can
 * offer stable filter values. Rows are ranked by count and then value to keep
 * the list from jumping between refreshes.
 */
export function libraryFacets(items) {
  const tags = new Map();
  const sites = new Map();
  const months = new Map();
  for (const candidate of Array.isArray(items) ? items : []) {
    const item = libraryEntry(candidate);
    if (!item) continue;
    const seenTags = new Set();
    for (const tag of Array.isArray(item.tags) ? item.tags : []) {
      if (typeof tag !== 'string' || !tag.trim()) continue;
      const key = normalizeText(tag.trim());
      if (seenTags.has(key)) continue;
      seenTags.add(key);
      const entry = tags.get(key) || { value: tag.trim(), count: 0 };
      entry.count += 1;
      tags.set(key, entry);
    }
    const site = String(item.site || '').trim();
    if (site) {
      const key = normalizeText(site);
      const entry = sites.get(key) || { value: site, count: 0 };
      entry.count += 1;
      sites.set(key, entry);
    }
    const month = monthOf(item.updatedAt || item.createdAt);
    if (month) {
      const entry = months.get(month) || { value: month, count: 0 };
      entry.count += 1;
      months.set(month, entry);
    }
  }
  return { tags: rankFacet(tags), sites: rankFacet(sites), months: rankFacet(months) };
}

function rankFacet(map) {
  return [...map.values()].sort((a, b) => b.count - a.count
    || a.value.localeCompare(b.value, 'en'));
}

/** A single `tag` may also arrive as a list; every requested tag must match. */
function tagFilterKeys(tag) {
  const values = (Array.isArray(tag) ? tag : [tag]).map(value => String(value ?? '').trim()).filter(Boolean);
  return values.length ? values.map(normalizeText) : null;
}

/**
 * `since` is a lower bound only: `YYYY-MM` means "that month and anything
 * newer", which is what the name promises. Month and day forms are anchored in
 * local time (matching the month facet and the exported file name) and the
 * instant itself is inclusive, so a record saved at 00:00 on the first day is
 * inside the range. Bounding one single month would need an `until` the panel
 * does not ask for yet.
 */
function sinceStart(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const month = /^(\d{4})-(\d{1,2})$/u.exec(text);
  if (month) {
    const index = Number(month[2]) - 1;
    return index < 0 || index > 11 ? null : new Date(Number(month[1]), index, 1).getTime();
  }
  const day = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(text);
  if (day) {
    const start = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
    return Number.isNaN(start) ? null : start;
  }
  const instant = Date.parse(text);
  return Number.isNaN(instant) ? null : instant;
}

/** Search the complete collection before paging, including notes and answers. */
export function libraryPage(insights, annotations, { query = '', kind = 'all', page = 1, tag, site, since, sort = 'updated' } = {}) {
  const terms = normalizeText(query).trim().split(/\s+/u).filter(Boolean);
  const tagKeys = tagFilterKeys(tag);
  const siteKey = String(site ?? '').trim() ? normalizeText(String(site).trim()) : '';
  const sinceAt = sinceStart(since);
  const all = [
    ...(Array.isArray(insights) ? insights : []).map(record => ({ kind: 'insight', record, item: libraryItem('insight', record) })),
    ...(Array.isArray(annotations) ? annotations : []).map(record => ({ kind: 'annotation', record, item: libraryItem('annotation', record) })),
  ];
  // Sorting by the existing timestamp string keeps legacy callers byte-identical;
  // `created` only swaps which field is read first.
  const timeOf = sort === 'created' ? entry => entry.item.createdAt : entry => entry.item.updatedAt;
  const matches = all.filter(entry => {
    if (kind !== 'all' && entry.kind !== kind) return false;
    const record = entry.record;
    // The searched field set is frozen on the raw record: normalising first
    // would drop whichever of record.url / document.url lost the tie-break and
    // silently change results that existing callers already rely on.
    const searchable = normalizeText([record.title, record.url, record.document?.title, record.document?.url,
      record.quote, record.anchor?.quote, record.note, record.aiAnswer, ...(record.tags || [])].join(' '));
    if (!terms.every(term => searchable.includes(term))) return false;
    if (tagKeys && !tagKeys.every(key => entry.item.tags.some(value => normalizeText(value) === key))) return false;
    if (siteKey && normalizeText(entry.item.site) !== siteKey) return false;
    if (sinceAt !== null) {
      // A record without a readable timestamp cannot be proven to fall inside
      // the range, so it is excluded rather than guessed at.
      const time = timestampOf(entry.item.updatedAt || entry.item.createdAt);
      if (Number.isNaN(time) || time < sinceAt) return false;
    }
    return true;
  }).sort((a, b) => timeOf(b).localeCompare(timeOf(a))
    || `${a.kind}:${a.record.id}`.localeCompare(`${b.kind}:${b.record.id}`));
  const pages = Math.max(1, Math.ceil(matches.length / LIBRARY_PAGE_SIZE));
  const current = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  return { items: matches.slice((current - 1) * LIBRARY_PAGE_SIZE, current * LIBRARY_PAGE_SIZE)
    .map(({ kind: entryKind, record }) => ({ kind: entryKind, record })),
  total: matches.length, collectionTotal: all.length, page: current, pages };
}

/** Undo stays in this panel's memory; never overwrite a record restored elsewhere. */
export function createLibraryDeletion(store) {
  const deleted = [];
  let queue = Promise.resolve();
  const run = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const methods = kind => {
    if (kind === 'insight') return { list: () => store.listInsights(), remove: id => store.deleteInsight(id), save: record => store.saveInsight(record) };
    if (kind === 'annotation') return { list: () => store.listAnnotations(), remove: id => store.deleteAnnotation(id), save: record => store.saveAnnotation(record) };
    throw new Error('Unknown library record type');
  };
  return {
    get count() { return deleted.length; },
    remove(kind, record) {
      return run(async () => {
        const access = methods(kind);
        const current = (await access.list()).find(item => item.id === record.id);
        if (!current) return null;
        const snapshot = structuredClone(current);
        await access.remove(snapshot.id);
        deleted.push({ kind, record: snapshot });
        return snapshot;
      });
    },
    undo: () => run(async () => {
      const item = deleted.at(-1);
      if (!item) return null;
      const access = methods(item.kind);
      const exists = (await access.list()).some(record => record.id === item.record.id);
      if (!exists) await access.save(item.record);
      deleted.pop();
      return { ...item, restored: !exists };
    }),
    reset: () => run(() => { deleted.length = 0; }),
  };
}
