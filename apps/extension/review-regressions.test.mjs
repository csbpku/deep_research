import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { applyTextTranslations, boundTaskContext, makeDocument, mergeProcessedIds, translateBlocks } from './reader-core.js';
import { readerStore } from './reader-store.js';
import { createBackgroundHarness, waitFor } from './test-helpers/background-runtime.mjs';
import { isBundledDemoUrl } from './reader-demo.js';
import { estimateTranslation, formatTokens } from './cost-estimate.js';
import { createUsageRecorder } from './usage-persistence.js';
import { mergeUsage, pruneUsage } from './usage-meter.js';
import { parseLibraryAnswer } from './library-answer.js';

const source = readFileSync(new URL('./sidepanel.js', import.meta.url), 'utf8');
const t = (text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => String(values[index]));
function actualFunction(start, end, globals) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin, 'actual function boundaries must exist');
  return vm.runInNewContext(`${source.slice(begin, finish)}\n${start.match(/function (\w+)/)[1]}`, { t, ...globals });
}

test('usage settings capture the selected answer effort before asynchronous writes can refresh the form', async () => {
  const nodes = {
    'translation-model': { value: '' }, 'answer-reasoning-mode': { value: 'high' },
    'price-input': { value: '' }, 'price-output': { value: '' }, 'usage-settings-status': {},
  };
  const saved = new Map();
  const save = actualFunction('async function saveUsageSettings(', '\nasync function recordUsageEvent(', {
    $: id => nodes[id], translationModel: '', answerReasoningMode: 'auto', pricing: {},
    readerStore: { async setSetting(key, value) {
      saved.set(key, value);
      if (key === 'translationModel') nodes['answer-reasoning-mode'].value = 'auto';
    } },
  });
  await save();
  assert.equal(saved.get('answerReasoningMode'), 'high');
});

function translationPanel({ failBookkeeping = false, sendMessage = async () => ({ ok: true }), localTranslate } = {}) {
  const calls = { worker: 0, local: 0, usage: [] };
  const job = { id: 'translation-test', status: 'queued', targetLanguage: 'zh-CN' };
  const context = { url: 'https://article.invalid/', title: 'Backpressure', body: 'Backpressure protects queues.', contentHash: 'fixture', full: true,
    targetLanguage: 'zh-CN', blocks: [{ id: 'p1', text: 'Backpressure protects queues.', kind: 'paragraph' }], images: [] };
  const globals = {
    translationRequested: true, translationRunning: true, activeTranslationRun: 1,
    activeJobRecord: job, translationController: new AbortController(), boundWindowTabId: null,
    activeTabId: 1, documentContext: null, failedTranslationItems: [],
    translatedTextIds: new Set(), translatedImageIds: new Set(),
    platformModeReady: () => false, platformDemoUnsupported: () => false,
    boundTaskContext, currentTranslationLanguage: () => 'zh-CN',
    currentGlossaryPrompt: () => 'Preferred terms', translationModel: 'translation-model',
    updatePageContextUi() {}, translationCoverageWarning: () => '', estimateTranslation,
    chrome: { runtime: { sendMessage: async message => { calls.worker += 1; return sendMessage(message); } } },
    persistJobPatch: (target, patch) => {
      if (patch.workerManaged && failBookkeeping) throw new Error('panel storage unavailable');
      Object.assign(target, patch);
    },
    recordUsageEvent: async (_kind, event) => calls.usage.push(event), saveGuideState: async () => {},
    makeDocument, mergeProcessedIds, applyTextTranslations,
    mergeTranslationFailures: (old = [], failed = [], resolved = []) => [...old.filter(i => !resolved.includes(i.id)), ...failed],
    sendToPage: async payload => ({ ok: true, appliedIds: (payload.translations || []).map(i => i.id) }),
    renderProgress() {}, formatTokens, setNotice() {}, readingProvider: () => ({ model: 'fixture' }),
    translateBlocks: async (_provider, _document, blocks, options) => {
      calls.local += 1;
      if (localTranslate) return localTranslate(_provider, _document, blocks, options);
      return blocks.map(block => ({ ...block, text: '队列受到保护。', sourceText: block.text }));
    },
    renderTranslationFailures() {}, saveLocalSession: async () => {}, DOMException,
  };
  return { calls, context, run: actualFunction('async function processDocument(', '\nconst FULL_PAGE_SUMMARY_PROMPT', globals) };
}

test('a worker-accepted translation never also starts the panel executor', async () => {
  const panel = translationPanel();
  await panel.run(panel.context);
  assert.equal(panel.calls.worker, 1);
  assert.equal(panel.calls.local, 0);
  assert.equal(panel.calls.usage.length, 1);
  assert.equal(panel.calls.usage[0].requests, estimateTranslation(panel.context).requests);
});

test('bookkeeping failure after worker acceptance cannot launch another executor', async () => {
  const panel = translationPanel({ failBookkeeping: true });
  await panel.run(panel.context);
  assert.equal(panel.calls.worker, 1);
  assert.equal(panel.calls.local, 0);
});

test('the real panel handoff and worker pipeline make exactly one model request', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    await readerStore.clearAll();
    await readerStore.setSetting('provider', { baseUrl: 'http://127.0.0.1:1234/v1', model: 'chat-model', apiKey: '' });
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '背压保护队列。' }, finish_reason: 'stop' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const worker = createBackgroundHarness();
    const panel = translationPanel({ sendMessage: worker.dispatch, localTranslate: translateBlocks });
    await panel.run(panel.context);
    await waitFor(async () => (await readerStore.getJob('translation-test'))?.status === 'completed');
    assert.equal(panel.calls.worker, 1);
    assert.equal(panel.calls.local, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'translation-model');
    assert.match(requests[0].messages[0].content, /Preferred terms/u);
  } finally {
    globalThis.fetch = originalFetch;
    await readerStore.clearAll();
  }
});

test('platform library questions never send saved evidence through an old BYOK provider', async () => {
  const nodes = Object.fromEntries(['library-ask-input', 'library-ask-status', 'library-ask-answer', 'library-ask-citations', 'library-ask'].map(key => [key, {}]));
  nodes['library-ask-input'].value = 'Explain backpressure';
  let sent = 0;
  const ask = actualFunction('async function askLibrary(', '\nfunction safeCitationUrl(', {
    $: id => nodes[id], readingMode: 'platform', platformConnected: true,
    provider: { model: 'stale-byok', baseUrl: 'https://stale-provider.invalid' },
    textModelReady: () => true, providerReady: () => true,
    libraryShelf: [], selectLibraryEvidence: () => ({ terms: ['backpressure'], evidence: [{ quote: 'Saved private quote' }] }),
    buildLibraryAnswerMessages: () => [], requestChat: async () => { sent += 1; throw new Error('must not send'); },
    show() {}, showModelSetupGuidance() {},
  });
  await ask();
  assert.equal(sent, 0);
  assert.match(nodes['library-ask-status'].textContent, /独立模式/);
});

test('platform mode does not offer the bundled standalone-only demo guide', () => {
  const card = {};
  const render = actualFunction('function renderGuide(', '\nasync function saveGuideState(', {
    $: id => id === 'guide-card' ? card : { classList: { toggle() {}, contains: () => true }, setAttribute() {} },
    guideState: {}, readingMode: 'platform', provider: null, pageContext: null, documentContext: null, selectionContext: null,
    providerReady: () => false, textModelReady: () => true,
    document: { querySelector: () => ({ dataset: { workspaceView: 'chat' } }) },
    show: (node, visible) => { node.visible = visible; },
  });
  render();
  assert.equal(card.visible, false);
});

test('the first-run guide stays visible for the demo without taking space from ordinary articles', () => {
  for (const [url, expected] of [[null, true], ['https://article.invalid/', false], ['chrome-extension://reader-unit/demo.html', true]]) {
    const card = {};
    const render = actualFunction('function renderGuide(', '\nasync function saveGuideState(', {
      $: id => id === 'guide-card' ? card : { classList: { toggle() {}, contains: () => true }, setAttribute() {} },
      guideState: { ask: true }, readingMode: 'local', provider: { model: 'fixture' },
      providerReady: () => true, pageContext: url ? { url } : null, documentContext: null, selectionContext: null,
      chrome: { runtime: { getURL: path => `chrome-extension://reader-unit/${path}` } }, isBundledDemoUrl,
      document: { querySelector: () => ({ dataset: { workspaceView: 'chat' } }) },
      show: (node, visible) => { node.visible = visible; },
    });
    render();
    assert.equal(card.visible, expected, `guide visibility for ${url || 'empty view'}`);
  }
});

test('panel usage events share the worker recorder without local storage writes', async () => {
  let stored;
  const storage = {
    get: async () => structuredClone(stored || {}),
    set: async patch => { stored = structuredClone(patch); },
  };
  const recorder = createUsageRecorder(storage);
  let messages = 0;
  const record = actualFunction('async function recordUsageEvent(', '\nfunction recordAnswerUsage(', {
    chrome: { runtime: { sendMessage: async message => {
      assert.equal(message.type, 'deep-research:record-usage');
      messages += 1;
      return { ok: true, usage: await recorder(message.event) };
    } }, storage: { local: { get() { throw new Error('must use worker'); }, set() { throw new Error('must use worker'); } } } },
    usageDay: () => new Date().toLocaleDateString('sv-SE'), usageState: {}, mergeUsage,
    renderUsageSummary() {},
  });
  await Promise.all([record('translation', { requests: 1, chars: 10 }), record('answer', { requests: 1, chars: 20 })]);
  assert.equal(messages, 2);
  assert.equal(stored.readerUsage.totals.translation.requests, 1);
  assert.equal(stored.readerUsage.totals.answer.requests, 1);
});

test('a sparse library citation keeps the same number in the answer and rendered source', () => {
  const evidence = [1, 2, 3].map(index => ({ id: `e${index}`, title: `Source ${index}`, url: `https://source-${index}.invalid/`, quote: `Evidence ${index}` }));
  const parsed = parseLibraryAnswer('{"answer":"Supported by [3].","citations":[3]}', evidence);
  const host = { children: [], replaceChildren() { this.children = []; }, append(node) { this.children.push(node); } };
  const render = actualFunction('function renderLibraryCitations(', '\nfunction setLibraryNotice(', {
    document: { createElement: tag => ({ tag }) },
    safeCitationUrl: value => value, show() {}, URL,
  });
  render(host, parsed.citations);
  const links = host.children.filter(node => node.tag === 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].textContent, '[3] Source 3');
});

test('opening another panel cannot overwrite a usage event committed while settings load', async () => {
  let stored;
  let unblock;
  let started;
  const waiting = new Promise(resolve => { unblock = resolve; });
  const settingsStarted = new Promise(resolve => { started = resolve; });
  const storage = { get: async () => structuredClone(stored || {}), set: async value => { stored = structuredClone(value); } };
  const record = createUsageRecorder(storage);
  await record({ kind: 'translation', requests: 1 });
  const load = actualFunction('async function loadUsageSettings(', '\nfunction renderUsageSettings(', {
    readerStore: { getSetting: async (_key, fallback) => { started(); await waiting; return fallback; } },
    translationModel: '', pricing: {}, usageState: {}, USAGE_KEY: 'readerUsage', mergeUsage, pruneUsage,
    chrome: { storage: { local: { get: storage.get, set() { throw new Error('initialization must be read-only'); } } } },
  });
  const opening = load();
  await settingsStarted;
  await record({ kind: 'answer', requests: 1 });
  unblock();
  await opening;
  assert.equal(stored.readerUsage.totals.translation.requests, 1);
  assert.equal(stored.readerUsage.totals.answer.requests, 1);
});
