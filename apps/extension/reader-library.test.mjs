import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createLibraryDeletion, libraryPage, LIBRARY_PAGE_SIZE } from './reader-library.js';
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
      classList: { remove() {} }, setAttribute() {}, removeAttribute() {}, focus() { this.focused = !this.disabled; } });
    return nodes.get(id);
  };
}

test('the actual composer follows selection scope, resets to article and hides the starter for images', () => {
  const $ = nodeMap();
  const sandbox = { $, t, document: { querySelector: () => ({ dataset: { workspaceView: 'chat' } }) },
    activeDiscussionContext: () => ({ selection: { quote: 'Selected source' } }), updateTranslationLanguageUi() {},
    pageReadDescriptor: () => ({ label: 'Ready', detail: '' }), show: (element, visible) => { element.visible = visible; },
    imageContext: { image: {} }, contextHasReadableBody: () => true, discussionScopeLabel: scope => scope,
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
  const sandbox = { $, t, libraryDeletion: deletion, libraryMutationBusy: false, pageContext: null, documentContext: null, selectionContext: null,
    show: (element, visible) => { element.visible = visible; }, updateLibrary: async () => {},
    window: { confirm: () => false }, record: store.insights.get('a') };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function setLibraryNotice('), source.indexOf('async function openKnowledgeUrl(')), sandbox);
  await vm.runInContext("deleteLibraryRecord('insight', record)", sandbox);
  assert.equal(store.insights.has('a'), true);
  assert.equal(deletion.count, 0);
  sandbox.window.confirm = () => true;
  await vm.runInContext("deleteLibraryRecord('insight', record)", sandbox);
  assert.equal(store.insights.has('a'), false);
  assert.equal($('undo-library-delete').visible, true);
  assert.equal($('undo-library-delete').focused, true);
  assert.match($('library-notice-text').textContent, /Saved evidence/);
  await vm.runInContext('undoLibraryDelete()', sandbox);
  assert.equal(store.insights.has('a'), true);
  assert.equal($('undo-library-delete').visible, false);
});

test('late collection reads cannot overwrite a newer filter result', async () => {
  const $ = nodeMap();
  const pending = [];
  const rendered = [];
  const sandbox = { $, t, libraryPage, LIBRARY_PAGE_SIZE, libraryView: { query: '', kind: 'all', page: 1 }, libraryRenderRequest: 0,
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
