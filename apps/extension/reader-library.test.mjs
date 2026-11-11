import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createLibraryDeletion, editTags, libraryFacets, libraryItems, libraryPage, LIBRARY_PAGE_SIZE } from './reader-library.js';
import { readerStore } from './reader-store.js';

const items = (count, prefix) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, title: `${prefix} ${index}`,
  createdAt: new Date(2026, 0, index + 1).toISOString(), document: { url: `https://example.test/${index}` }, anchor: { quote: `Source ${index}` } }));

test('every saved item remains reachable beyond twelve records per type', () => {
  const insights = items(37, 'insight');
  const annotations = items(25, 'annotation');
  const first = libraryPage(insights, annotations);
  assert.equal(first.collectionTotal, 62);
  const seen = [];
  for (let page = 1; page <= first.pages; page++) seen.push(...libraryPage(insights, annotations, { page }).items.map(item => `${item.kind}:${item.record.id}`));
  assert.equal(new Set(seen).size, 62);
  assert.equal(seen.length, 62);
  assert.equal(libraryPage(insights, annotations, { kind: 'annotation', page: 3 }).items.length, 1);
});

test('search includes old annotations, notes, answers, tags and source URLs before paging', () => {
  const annotations = items(25, 'annotation');
  annotations[0].note = '架构 队列';
  const insights = [{ id: 'note', note: 'ＡＩ REVIEW', aiAnswer: 'Bounded queues', tags: ['performance'], url: 'https://research.test/source' }];
  for (const query of ['ai review', 'bounded', 'performance', 'research.test']) {
    assert.equal(libraryPage(insights, annotations, { query }).items[0].record.id, 'note');
  }
  assert.equal(libraryPage(insights, annotations, { query: '架构 队列', kind: 'annotation' }).items[0].record.id, 'annotation-0');
  assert.equal(libraryPage(insights, annotations, { query: '架构 missing' }).total, 0);
  assert.equal(libraryPage(insights, annotations, { query: 'bounded', kind: 'annotation' }).total, 0);
});

test('filter changes, deletion and empty collections clamp the current page', () => {
  const insights = items(30, 'insight');
  assert.equal(libraryPage(insights, [], { page: 999 }).page, 3);
  const filtered = libraryPage(insights, [], { query: 'insight 29', page: 3 });
  assert.equal(filtered.page, 1);
  assert.equal(filtered.total, 1);
  const empty = libraryPage([], [], { page: -5 });
  assert.equal(empty.page, 1);
  assert.equal(empty.pages, 1);
  assert.deepEqual(empty.items, []);
});

function memoryStore() {
  const insights = new Map();
  const annotations = new Map();
  return { insights, annotations,
    listInsights: async () => [...insights.values()], listAnnotations: async () => [...annotations.values()],
    deleteInsight: async id => insights.delete(id), deleteAnnotation: async id => annotations.delete(id),
    saveInsight: async record => insights.set(record.id, record), saveAnnotation: async record => annotations.set(record.id, record),
  };
}

test('delete and repeated undo restore original record types without overwriting newer work', async () => {
  const store = memoryStore();
  const deletion = createLibraryDeletion(store);
  store.insights.set('same-id', { id: 'same-id', note: 'Old note' });
  store.annotations.set('same-id', { id: 'same-id', note: 'Annotation' });
  await deletion.remove('insight', { id: 'same-id' });
  await deletion.remove('annotation', { id: 'same-id' });
  assert.equal(deletion.count, 2);
  assert.equal((await deletion.undo()).kind, 'annotation');
  assert.equal(store.annotations.get('same-id').note, 'Annotation');
  store.insights.set('same-id', { id: 'same-id', note: 'Restored and edited elsewhere' });
  assert.equal((await deletion.undo()).restored, false);
  assert.equal(store.insights.get('same-id').note, 'Restored and edited elsewhere');
  assert.equal(deletion.count, 0);
});

test('undo captures latest saved content and survives a failed restore', async () => {
  const store = memoryStore();
  const deletion = createLibraryDeletion(store);
  store.insights.set('updated', { id: 'updated', note: 'Latest revision' });
  await deletion.remove('insight', { id: 'updated', note: 'Stale list snapshot' });
  const save = store.saveInsight;
  store.saveInsight = async () => { throw new Error('disk full'); };
  await assert.rejects(deletion.undo(), /disk full/);
  assert.equal(deletion.count, 1);
  store.saveInsight = save;
  await deletion.undo();
  assert.equal(store.insights.get('updated').note, 'Latest revision');
});

test('failed or stale deletion never creates a bogus undo, and reset clears queued history', async () => {
  const store = memoryStore();
  const deletion = createLibraryDeletion(store);
  assert.equal(await deletion.remove('insight', { id: 'missing' }), null);
  store.insights.set('a', { id: 'a' });
  const remove = store.deleteInsight;
  store.deleteInsight = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(deletion.remove('insight', { id: 'a' }), /storage unavailable/);
  assert.equal(deletion.count, 0);
  store.deleteInsight = remove;
  const pending = deletion.remove('insight', { id: 'a' });
  const reset = deletion.reset();
  await Promise.all([pending, reset]);
  assert.equal(await deletion.undo(), null);
  assert.equal(deletion.count, 0);
});

test('real store undo retains the evidence anchor, personal note, answer and tags', async () => {
  const deletion = createLibraryDeletion(readerStore);
  const record = await readerStore.saveInsight({ id: 'library-undo-evidence', url: 'https://library.test/article',
    document: { url: 'https://library.test/article', version: 'v1' }, quote: 'Original evidence', note: 'My judgment',
    aiAnswer: 'AI interpretation', tags: ['review'], anchor: { quote: 'Original evidence', contentHash: 'v1' } });
  await deletion.remove('insight', record);
  assert.equal(await readerStore.getInsight(record.id), null);
  await deletion.undo();
  const restored = await readerStore.getInsight(record.id);
  for (const key of ['id', 'url', 'document', 'quote', 'note', 'aiAnswer', 'tags', 'anchor', 'createdAt']) assert.deepEqual(restored[key], record[key]);
});

const source = readFileSync(new URL('./sidepanel.js', import.meta.url), 'utf8');
const t = (message, ...values) => message.replace(/\{(\d+)\}/gu, (_, index) => String(values[index] ?? ''));
function nodeMap() {
  const nodes = new Map();
  return id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', dataset: {}, disabled: false, visible: true,
      classList: { remove() {} }, setAttribute() {}, removeAttribute() {}, focus() { this.focused = !this.disabled; },
      replaceChildren(...items) { this.children = items; } });
    return nodes.get(id);
  };
}

test('the actual composer follows selection scope, resets to article and hides the starter for images', () => {
  const $ = nodeMap();
  const sandbox = { $, t, document: { querySelector: () => ({ dataset: { workspaceView: 'chat' } }) },
    activeDiscussionContext: () => ({ selection: { quote: 'Selected source' } }), updateTranslationLanguageUi() {},
    pageReadDescriptor: () => ({ label: 'Ready', detail: '' }), show: (element, visible) => { element.visible = visible; },
    imageContext: { image: {} }, contextHasReadableBody: () => true, discussionScopeLabel: scope => scope, discussionScopeShortLabel: scope => scope,
    fitComposerInput() {}, readingMode: 'local', provider: { model: 'test' }, updateSendAvailability() {}, discussionRunning: false };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function renderPersistentComposer('), source.indexOf('function platformModeReady(')), sandbox);
  for (const [scope, label, visible] of [['page', '文章讲了什么？', true], ['selection', '这段讲了什么？', true], ['page', '文章讲了什么？', true], ['image', '文章讲了什么？', false]]) {
    sandbox.scope = scope;
    vm.runInContext('renderPersistentComposer(scope)', sandbox);
    assert.equal($('starter-summary').textContent, label);
    assert.equal($('starter-summary').visible, visible);
  }
});

test('the actual deletion controller honors cancel and exposes working undo after confirmation', async () => {
  const store = memoryStore();
  const $ = nodeMap();
  store.insights.set('a', { id: 'a', title: 'Saved evidence' });
  const deletion = createLibraryDeletion(store);
  const refreshed = [];
  const sandbox = { $, t, libraryDeletion: deletion, libraryMutationBusy: false, pageContext: { url: 'https://example.test' }, documentContext: null, selectionContext: null,
    applyAnnotationsForContext: async context => refreshed.push(context.url),
    show: (element, visible) => { element.visible = visible; }, updateLibrary: async () => {},
    window: { confirm: () => false }, record: store.insights.get('a') };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function setLibraryNotice('), source.indexOf('async function openKnowledgeUrl(')), sandbox);
  await vm.runInContext("deleteLibraryRecord('insight', record)", sandbox);
  assert.equal(store.insights.has('a'), true);
  assert.equal(deletion.count, 0);
  assert.equal(refreshed.length, 0);
  sandbox.window.confirm = () => true;
  await vm.runInContext("deleteLibraryRecord('insight', record)", sandbox);
  assert.equal(store.insights.has('a'), false);
  assert.equal($('undo-library-delete').visible, true);
  assert.equal($('undo-library-delete').focused, true);
  assert.match($('library-notice-text').textContent, /Saved evidence/);
  assert.equal(refreshed.length, 1);
  await vm.runInContext('undoLibraryDelete()', sandbox);
  assert.equal(store.insights.has('a'), true);
  assert.equal($('undo-library-delete').visible, false);
  assert.equal(refreshed.length, 2);
});

test('late collection reads cannot overwrite a newer filter result', async () => {
  const $ = nodeMap();
  const pending = [];
  const rendered = [];
  const sandbox = { $, t, libraryPage, libraryItems, libraryFacets, LIBRARY_PAGE_SIZE,
    readingMode: 'local',
    // The tag menu builds native <option> elements; the panel always has DOM,
    // this harness models just enough of it.
    Option: class { constructor(text, value) { this.text = text; this.value = value; } }, libraryView: { query: '', kind: 'all', page: 1, tag: '' }, libraryRenderRequest: 0,
    updatePageKnowledge: async () => {}, readerStore: { listInsights: () => new Promise(resolve => pending.push(resolve)), listAnnotations: async () => [] },
    renderMaterialRecords: (_host, records) => rendered.push(records), show: (element, visible) => { element.visible = visible; },
    setLibraryNotice: message => assert.fail(message) };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('async function updateLibrary('), source.indexOf('function setLibraryNotice(')), sandbox);
  const oldRead = vm.runInContext('updateLibrary()', sandbox);
  sandbox.libraryView.query = 'new';
  const newRead = vm.runInContext('updateLibrary()', sandbox);
  pending[1]([{ id: 'new', title: 'new result' }]);
  await newRead;
  pending[0]([{ id: 'old', title: 'old result' }]);
  await oldRead;
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0][0].key, 'insight:new');
  assert.match($('library-summary').textContent, /1/);
});

// ---------------------------------------------------------------------------
// Search, facets and filters. The legacy function below is a frozen copy of the
// pre-filter implementation: any new option that leaks into the default path
// shows up as a diff here.
// ---------------------------------------------------------------------------
function legacyLibraryPage(insights, annotations, { query = '', kind = 'all', page = 1 } = {}) {
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase();
  const terms = normalize(query).trim().split(/\s+/u).filter(Boolean);
  const all = [
    ...insights.map(record => ({ kind: 'insight', record })),
    ...annotations.map(record => ({ kind: 'annotation', record })),
  ];
  const matches = all.filter(item => {
    if (kind !== 'all' && item.kind !== kind) return false;
    const record = item.record;
    const searchable = normalize([record.title, record.url, record.document?.title, record.document?.url,
      record.quote, record.anchor?.quote, record.note, record.aiAnswer, ...(record.tags || [])].join(' '));
    return terms.every(term => searchable.includes(term));
  }).sort((a, b) => String(b.record.updatedAt || b.record.createdAt || '').localeCompare(String(a.record.updatedAt || a.record.createdAt || ''))
    || `${a.kind}:${a.record.id}`.localeCompare(`${b.kind}:${b.record.id}`));
  const pages = Math.max(1, Math.ceil(matches.length / LIBRARY_PAGE_SIZE));
  const current = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  return { items: matches.slice((current - 1) * LIBRARY_PAGE_SIZE, current * LIBRARY_PAGE_SIZE),
    total: matches.length, collectionTotal: all.length, page: current, pages };
}

function mixedCollection() {
  const insights = Array.from({ length: 19 }, (_, index) => ({
    id: `insight-${index}`,
    url: index % 3 === 0 ? undefined : `https://site-${index % 4}.test/p/${index}`,
    document: index % 3 === 0 ? { url: `https://docs.test/a/${index}`, title: `Doc ${index}` } : undefined,
    title: index % 5 === 0 ? undefined : `Article ${index}`,
    quote: index % 2 === 0 ? `Evidence ${index}` : '',
    note: index % 4 === 0 ? '队列 bounded' : '',
    aiAnswer: index % 6 === 0 ? 'Queues need backpressure' : '',
    tags: index % 7 === 0 ? ['performance', 'ＡＩ'] : [],
    createdAt: new Date(Date.UTC(2026, 9, 1 + index, 12)).toISOString(),
    updatedAt: index % 3 === 0 ? undefined : new Date(Date.UTC(2026, 10, 1 + index, 9)).toISOString(),
  }));
  const annotations = Array.from({ length: 11 }, (_, index) => ({
    id: `annotation-${index}`,
    document: { url: `https://notes.test/n/${index}`, title: index % 2 ? `Noted ${index}` : '', version: 'v1' },
    anchor: { quote: index % 3 === 0 ? 'Full width ＡＩ text' : `Highlight ${index}` },
    note: index % 4 === 1 ? 'my note' : '',
    tags: index % 5 === 0 ? ['Review'] : [],
    createdAt: new Date(Date.UTC(2026, 9, 20 + index, 8)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 10, 5 + index, 8)).toISOString(),
  }));
  return { insights, annotations };
}

test('legacy callers (query / kind / page only) get byte-identical pages', () => {
  const { insights, annotations } = mixedCollection();
  const queries = ['', 'article', 'queue', 'ｑｕｅｕｅ', 'ＡＩ', 'docs.test', 'highlight', 'missing'];
  const kinds = ['all', 'insight', 'annotation'];
  let comparisons = 0;
  for (const query of queries) for (const kind of kinds) for (const page of [1, 2, 3, 99, -4, 0]) {
    assert.deepEqual(libraryPage(insights, annotations, { query, kind, page }),
      legacyLibraryPage(insights, annotations, { query, kind, page }), `${query}|${kind}|${page}`);
    comparisons += 1;
  }
  assert.ok(comparisons > 100);
  // The returned item shape is still { kind, record } carrying the raw record.
  const page = libraryPage(insights, annotations, { kind: 'annotation', page: 1 });
  assert.equal(page.items[0].record.anchor.quote.startsWith('Highlight') || page.items[0].record.anchor.quote.includes('ＡＩ'), true);
});

test('libraryItems normalises both storage shapes into one view model', () => {
  const insight = { id: 'i', url: 'https://Example.test/a?b=1', document: { url: 'https://doc.test/b', title: 'Doc title' },
    title: 'Record title', quote: 'Quote', note: 'Note', aiAnswer: 'Answer', tags: ['React', 'react', ' performance '],
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' };
  const annotation = { id: 'a', url: 'https://wrong.test/fallback', document: { url: 'https://doc.test/c', title: 'Annotation doc' },
    anchor: { quote: 'Anchored quote' }, note: 'Only note', createdAt: '2026-11-03T00:00:00.000Z' };
  const [first, second] = libraryItems([insight], [annotation]);
  assert.deepEqual(first, { kind: 'insight', id: 'i', url: 'https://Example.test/a?b=1', site: 'example.test',
    title: 'Doc title', quote: 'Quote', note: 'Note', aiAnswer: 'Answer', tags: ['React', 'performance'],
    updatedAt: '2026-11-02T00:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z' });
  assert.deepEqual(second, { kind: 'annotation', id: 'a', url: 'https://doc.test/c', site: 'doc.test',
    title: 'Annotation doc', quote: 'Anchored quote', note: 'Only note', aiAnswer: '', tags: [],
    updatedAt: '2026-11-03T00:00:00.000Z', createdAt: '2026-11-03T00:00:00.000Z' });

  // Missing / broken values degrade to empty strings rather than throwing.
  const [bare] = libraryItems([{ id: 'bare', url: 'not a url' }], []);
  assert.equal(bare.site, '');
  assert.equal(bare.title, '');
  assert.equal(bare.quote, '');
  assert.equal(bare.note, '');
  assert.equal(bare.aiAnswer, '');
  assert.deepEqual(bare.tags, []);
  assert.equal(bare.updatedAt, '');
  assert.equal(bare.createdAt, '');
  // Title falls back to the record title when the document has none.
  assert.equal(libraryItems([{ id: 't', title: 'Only title' }], [])[0].title, 'Only title');
});

test('tag filtering is case-insensitive, is AND-ed with query, and does not mutate the collection', () => {
  const insights = [
    { id: 'a', title: 'Queues', tags: ['Performance', 'Backpressure'] },
    { id: 'b', title: 'Queues', tags: ['performance'] },
    { id: 'c', title: 'Cache', tags: ['performance'] },
    { id: 'd', title: 'Untagged' },
  ];
  const ids = result => result.items.map(item => item.record.id);
  assert.deepEqual(ids(libraryPage(insights, [], { tag: 'PERFORMANCE' })), ['a', 'b', 'c']);
  assert.deepEqual(ids(libraryPage(insights, [], { tag: ' performance ' })), ['a', 'b', 'c']);
  assert.deepEqual(ids(libraryPage(insights, [], { tag: 'backpressure' })), ['a']);
  assert.deepEqual(ids(libraryPage(insights, [], { tag: 'performance', query: 'cache' })), ['c']);
  assert.deepEqual(ids(libraryPage(insights, [], { tag: 'performance', query: 'missing' })), []);
  assert.deepEqual(ids(libraryPage(insights, [], { tag: ['performance', 'backpressure'] })), ['a']);
  assert.equal(libraryPage(insights, [], { tag: 'unknown' }).total, 0);
  // A blank tag means "no tag filter", not "untagged only".
  assert.equal(libraryPage(insights, [], { tag: '' }).total, 4);
  assert.equal(libraryPage(insights, [], { tag: '   ' }).total, 4);
  assert.equal(libraryPage(insights, [], {}).total, 4);
});

test('site and since narrow the collection while totals keep reporting the full shelf', () => {
  const at = (month, day, hour = 12, minute = 0, second = 0) => localIso(month, day, hour, minute, second);
  const insights = [
    { id: 'nov-first', url: 'https://alpha.test/a', updatedAt: at(11, 1, 0, 0, 0) },
    { id: 'oct-last', url: 'https://alpha.test/b', updatedAt: at(10, 31, 23, 59, 59) },
    { id: 'dec-first', url: 'https://beta.test/c', updatedAt: at(12, 1, 0, 0, 0) },
    { id: 'undated', url: 'https://beta.test/d' },
  ];
  const ids = result => result.items.map(item => item.record.id);

  assert.deepEqual(ids(libraryPage(insights, [], { site: 'alpha.test' })), ['nov-first', 'oct-last']);
  assert.deepEqual(ids(libraryPage(insights, [], { site: 'ALPHA.TEST' })), ['nov-first', 'oct-last']);
  assert.deepEqual(ids(libraryPage(insights, [], { site: 'alpha.test', since: '2026-11' })), ['nov-first']);
  assert.deepEqual(ids(libraryPage(insights, [], { site: 'beta.test' })), ['dec-first', 'undated']);
  assert.equal(libraryPage(insights, [], { site: 'unknown.test' }).total, 0);
  // A page recorded under a URL that does not parse keeps its site empty, so no
  // site facet can ever claim it.
  assert.equal(libraryPage(insights, [], { site: '' }).total, 4);
  assert.deepEqual(ids(libraryPage([{ id: 'broken', url: 'not a url' }], [], { site: '' })), ['broken']);

  // `since` is a lower bound: the boundary month is included and newer months
  // come along, while the previous month (and undated records) stay out.
  const november = libraryPage(insights, [], { since: '2026-11' });
  assert.deepEqual(ids(november), ['dec-first', 'nov-first']);
  assert.equal(november.collectionTotal, 4);
  assert.equal(november.total, 2);
  assert.deepEqual(ids(libraryPage(insights, [], { since: '2026-10' })), ['dec-first', 'nov-first', 'oct-last']);
  assert.deepEqual(ids(libraryPage(insights, [], { since: '2026-12' })), ['dec-first']);
  assert.deepEqual(ids(libraryPage(insights, [], { since: '2027-01' })), []);
  // The first instant of the boundary month/day is inclusive.
  assert.deepEqual(ids(libraryPage(insights, [], { since: at(11, 1, 0, 0, 0) })), ['dec-first', 'nov-first']);
  assert.deepEqual(ids(libraryPage(insights, [], { since: '2026-11-01' })), ['dec-first', 'nov-first']);
  // One millisecond earlier must not match.
  assert.deepEqual(ids(libraryPage(insights, [], { since: new Date(Date.parse(at(11, 1, 0, 0, 0)) - 1).toISOString() })),
    ['dec-first', 'nov-first']);
  // Unparseable bounds are ignored instead of hiding everything.
  assert.equal(libraryPage(insights, [], { since: 'not-a-date' }).total, 4);
  assert.equal(libraryPage(insights, [], { since: '' }).total, 4);
  assert.equal(libraryPage(insights, [], { since: '  ' }).total, 4);
});

test('sort=created reorders only when asked; pagination envelope is unchanged', () => {
  const insights = [
    { id: 'old-created-new-updated', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
    { id: 'new-created-old-updated', createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
  ];
  const ids = result => result.items.map(item => item.record.id);
  assert.deepEqual(ids(libraryPage(insights, [], {})), ['old-created-new-updated', 'new-created-old-updated']);
  assert.deepEqual(ids(libraryPage(insights, [], { sort: 'updated' })), ['old-created-new-updated', 'new-created-old-updated']);
  assert.deepEqual(ids(libraryPage(insights, [], { sort: 'created' })), ['new-created-old-updated', 'old-created-new-updated']);
  assert.deepEqual(ids(libraryPage(insights, [], { sort: 'nonsense' })), ['old-created-new-updated', 'new-created-old-updated']);

  const { insights: many, annotations } = mixedCollection();
  const filtered = libraryPage(many, annotations, { tag: 'performance', page: 99 });
  const keys = Object.keys(filtered).sort();
  assert.deepEqual(keys, ['collectionTotal', 'items', 'page', 'pages', 'total']);
  assert.equal(filtered.page, filtered.pages);
  assert.equal(filtered.collectionTotal, 30);
  assert.ok(filtered.items.length <= LIBRARY_PAGE_SIZE);
  assert.deepEqual(libraryPage([], [], { tag: 'performance', since: '2026-11', page: -2 }),
    { items: [], total: 0, collectionTotal: 0, page: 1, pages: 1 });
});

test('facets rank by count then value and de-duplicate tags case-insensitively', () => {
  const items = libraryItems([
    { id: '1', url: 'https://a.test/1', tags: ['React', 'react', 'Tools'], updatedAt: localIso(10, 3) },
    { id: '2', url: 'https://a.test/2', tags: ['react', 'PERF'], updatedAt: localIso(10, 4) },
    { id: '3', url: 'https://b.test/3', tags: ['Perf', 'tools'], updatedAt: localIso(11, 5) },
    { id: '4', url: 'not a url', tags: [], updatedAt: localIso(11, 6) },
  ], []);
  const facets = libraryFacets(items);
  // Each tag keeps the casing of its first occurrence, so "PERF" is the label
  // and the later "Perf" is only a duplicate to fold in.
  assert.deepEqual(facets.tags, [{ value: 'PERF', count: 2 }, { value: 'React', count: 2 }, { value: 'Tools', count: 2 }]);
  assert.deepEqual(facets.sites, [{ value: 'a.test', count: 2 }, { value: 'b.test', count: 1 }]);
  // Equal counts fall back to ascending value, so every refresh keeps the order.
  assert.deepEqual(facets.months, [{ value: '2026-10', count: 2 }, { value: '2026-11', count: 2 }]);
  assert.deepEqual(libraryFacets([]), { tags: [], sites: [], months: [] });
  assert.deepEqual(libraryFacets(undefined), { tags: [], sites: [], months: [] });
  // Facets also accept the `{ kind, record }` entries the paginator returns, so
  // a caller cannot silently compute facets over empty rows.
  const raw = [
    { id: 'r1', url: 'https://a.test/1', tags: ['React'], updatedAt: localIso(10, 3) },
    { id: 'r2', url: 'https://b.test/2', tags: ['React', 'Perf'], updatedAt: localIso(10, 4) },
  ];
  const rawAnnotations = [{ id: 'r3', document: { url: 'https://b.test/2' }, anchor: { quote: 'q' },
    tags: ['React'], createdAt: localIso(10, 5) }];
  assert.deepEqual(libraryFacets(libraryPage(raw, rawAnnotations).items),
    libraryFacets(libraryItems(raw, rawAnnotations)));

  // Ranked facets on a real collection stay ranked after filtering.
  const { insights, annotations } = mixedCollection();
  const ranked = libraryFacets(libraryItems(insights, annotations));
  assert.ok(ranked.sites.length > 1);
  for (let index = 1; index < ranked.sites.length; index++) {
    const previous = ranked.sites[index - 1];
    const current = ranked.sites[index];
    assert.ok(previous.count > current.count || (previous.count === current.count && previous.value.localeCompare(current.value, 'en') < 0));
  }
});

/** Local wall-clock helper: month is 1-12 so the intent reads like a calendar. */
function localIso(month, day, hour = 12, minute = 0, second = 0, year = 2026) {
  return new Date(year, month - 1, day, hour, minute, second).toISOString();
}

test('tag maintenance renames case-insensitively, removes one tag and keeps the ten-tag limit', () => {
  assert.deepEqual(editTags(['React', 'react', 'Performance'], { renameFrom: 'react', renameTo: 'React 19' }), ['React 19', 'Performance']);
  assert.deepEqual(editTags(['React', 'Performance'], { remove: 'performance' }), ['React']);
  assert.deepEqual(editTags(['A', 'B'], { remove: 'missing' }), ['A', 'B']);
  const many = Array.from({ length: 12 }, (_, index) => `tag-${index}`);
  assert.equal(editTags(many, { remove: 'missing' }).length, 10);
  assert.deepEqual(editTags(['  ', null, 'Keep'], { renameFrom: 'none', renameTo: 'x' }), ['Keep']);
});
