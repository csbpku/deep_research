import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { readerStore } from './reader-store.js';
import { createBackgroundHarness, waitFor } from './test-helpers/background-runtime.mjs';

const originalFetch = globalThis.fetch;
const provider = { baseUrl: 'http://127.0.0.1:1234/v1', model: 'chat-model', apiKey: '' };
const context = (version = 'v1') => ({
  url: 'https://example.test/article', title: 'Queues', contentHash: version,
  targetLanguage: 'fr', full: true,
  blocks: [{ id: version, text: `The ${version} scheduler schedules workloads.`, kind: 'paragraph' }], images: [],
});
const completion = () => new Response(JSON.stringify({
  choices: [{ message: { content: 'Le planificateur organise les tâches.' }, finish_reason: 'stop' }],
}), { headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  await readerStore.clearAll();
  await readerStore.setSetting('provider', provider);
});
afterEach(() => { globalThis.fetch = originalFetch; });

test('worker translations honor the separately configured translation model', async () => {
  const requests = [];
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return completion(); };
  await readerStore.setSetting('translationModel', 'cheaper-model');
  const worker = createBackgroundHarness();
  await worker.dispatch({ type: 'deep-research:translation-start', jobId: 'model', tabId: 1, context: context(), translationModel: 'cheaper-model' });
  await waitFor(async () => (await readerStore.getJob('model'))?.status === 'completed');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'cheaper-model');
  assert.match(requests[0].messages[0].content, /fr/u);
});

test('dynamic snapshots retain their original model and glossary while queued behind an aborted request', async () => {
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length > 1) return completion();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  };
  const worker = createBackgroundHarness();
  await worker.dispatch({ type: 'deep-research:translation-start', jobId: 'dynamic', tabId: 1, context: context(), translationModel: 'selected-model', glossaryPrompt: 'GLOSSARY_A' });
  await waitFor(() => requests.length === 1);
  await readerStore.setSetting('translationModel', 'different-later-setting');
  await readerStore.setSetting('glossary', 'scheduler => GLOSSARY_B');
  await worker.dispatch({ type: 'deep-research:translation-start', jobId: 'dynamic', tabId: 1, context: context('v2') });
  await waitFor(async () => (await readerStore.getJob('dynamic'))?.status === 'completed');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].model, 'selected-model');
  assert.match(requests[1].messages[0].content, /GLOSSARY_A/u);
  assert.doesNotMatch(requests[1].messages[0].content, /GLOSSARY_B/u);
});

test('worker startup restores persisted translation configuration rather than current settings', async () => {
  const requests = [];
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return completion(); };
  await readerStore.setSetting('translationModel', 'later-model');
  await readerStore.setSetting('glossary', 'scheduler => LATER_GLOSSARY');
  await readerStore.saveJob({ id: 'resume', status: 'running', inputReady: true, tabId: 1 });
  await readerStore.saveTaskInput('resume', { ...context(), translationConfig: { translationModel: 'original-model', glossaryPrompt: 'ORIGINAL_GLOSSARY' } });
  createBackgroundHarness();
  await waitFor(async () => (await readerStore.getJob('resume'))?.status === 'completed');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'original-model');
  assert.match(requests[0].messages[0].content, /ORIGINAL_GLOSSARY/u);
  assert.doesNotMatch(requests[0].messages[0].content, /LATER_GLOSSARY/u);
});

test('legacy persisted tasks load saved translation settings while keeping their target language', async () => {
  const requests = [];
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return completion(); };
  await readerStore.setSetting('translationModel', 'legacy-selected-model');
  await readerStore.setSetting('glossary', 'scheduler => ancien-planificateur');
  await readerStore.saveJob({ id: 'legacy', status: 'running', inputReady: true, tabId: 1 });
  await readerStore.saveTaskInput('legacy', context());
  createBackgroundHarness();
  await waitFor(async () => (await readerStore.getJob('legacy'))?.status === 'completed');
  assert.equal(requests[0].model, 'legacy-selected-model');
  assert.match(requests[0].messages[0].content, /ancien-planificateur/u);
  assert.match(requests[0].messages[0].content, /fr/u);
});

test('an explicit empty configuration overrides old task and saved settings', async () => {
  const requests = [];
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return completion(); };
  await readerStore.setSetting('translationModel', 'saved-override');
  await readerStore.setSetting('glossary', 'scheduler => OLD_GLOSSARY');
  const worker = createBackgroundHarness();
  await worker.dispatch({ type: 'deep-research:translation-start', jobId: 'empty', tabId: 1,
    context: { ...context(), translationConfig: { translationModel: 'old-task-model', glossaryPrompt: 'OLD_GLOSSARY' } },
    translationModel: '', glossaryPrompt: '',
  });
  await waitFor(async () => (await readerStore.getJob('empty'))?.status === 'completed');
  assert.equal(requests[0].model, 'chat-model');
  assert.doesNotMatch(requests[0].messages[0].content, /OLD_GLOSSARY/u);
});

test('durable task input bounds translation options and excludes extra credential fields', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async () => { await waiting; return completion(); };
  const worker = createBackgroundHarness();
  await worker.dispatch({ type: 'deep-research:translation-start', jobId: 'bounded', tabId: 1,
    context: { ...context(), translationConfig: { apiKey: 'NEVER_PERSIST', translationModel: 'old', glossaryPrompt: 'old' } },
    translationModel: 'm'.repeat(500), glossaryPrompt: 'g'.repeat(5000),
  });
  const saved = await waitFor(() => readerStore.getTaskInput('bounded'));
  try {
    assert.equal(saved.translationConfig.translationModel.length, 256);
    assert.equal(saved.translationConfig.glossaryPrompt.length, 1200);
    assert.equal(JSON.stringify(saved).includes('NEVER_PERSIST'), false);
    assert.deepEqual(Object.keys(saved.translationConfig).sort(), ['glossaryPrompt', 'translationModel']);
  } finally { release(); }
  await waitFor(async () => (await readerStore.getJob('bounded'))?.status === 'completed');
});

test('recreated panels can activate the bundled demo without scripting injection', async () => {
  const worker = createBackgroundHarness();
  worker.tabs.set(9, { id: 9, windowId: 1, active: true, url: 'chrome-extension://reader-unit/demo.html?guide=1#intro' });
  worker.chrome.scripting.executeScript = async () => { throw new Error('Chrome rejects injection into extension pages'); };
  const result = await worker.dispatch({ type: 'deep-research:activate-current-page', tabId: 9 });
  assert.equal(result.ok, true);
  assert.equal(worker.injected.length, 0);
  assert.equal(worker.sent.filter(item => item.tabId === 9 && item.message.type === 'deep-research:request-page').length, 1);
});

test('the demo exception does not grant activation to other extension pages', async () => {
  const worker = createBackgroundHarness();
  worker.chrome.scripting.executeScript = async () => { throw new Error('protected extension page'); };
  for (const url of ['chrome-extension://foreign-extension/demo.html', 'chrome-extension://reader-unit/options.html']) {
    worker.tabs.set(9, { id: 9, windowId: 1, active: true, url });
    const result = await worker.dispatch({ type: 'deep-research:activate-current-page', tabId: 9 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsupported');
  }
  assert.equal(worker.sent.length, 0);
});

test('the worker paints each image before the next one completes, retaining progress and failures', async () => {
  let release;
  const tail = new Promise(resolve => { release = resolve; });
  const worker = createBackgroundHarness({
    translateImage: async (_provider, _document, image) => {
      if (image.id === 'second') { await tail; throw new Error('unreadable'); }
      return { ...image, regions: [], fallbackText: '第一张图片译文' };
    },
  });
  await worker.dispatch({ type: 'deep-research:translation-start', jobId: 'images', tabId: 1,
    context: { ...context(), blocks: [], images: [{ id: 'first' }, { id: 'second' }] },
  });
  try {
    await waitFor(() => worker.sent.find(item => item.message.type === 'deep-research:apply-image-translations'));
    const paints = worker.sent.filter(item => item.message.type === 'deep-research:apply-image-translations');
    assert.equal(paints.length, 1);
    assert.deepEqual(Array.from(paints[0].message.translations, item => item.id), ['first']);
    assert.equal(paints[0].message.documentUrl, context().url);
    const running = await readerStore.getJob('images');
    assert.equal(running.status, 'running');
  } finally { release(); }
  const job = await waitFor(async () => { const job = await readerStore.getJob('images'); return job?.status === 'completed_with_errors' && job; });
  assert.equal(job.imageDone, 2);
  assert.deepEqual(job.failedItems.map(item => item.id), ['second']);
  assert.equal(worker.sent.filter(item => item.message.type === 'deep-research:apply-image-translations').length, 1);
});

test('cancelling an image translation does not paint a late result or start the next image', async () => {
  let release;
  const tail = new Promise(resolve => { release = resolve; });
  const started = [];
  const worker = createBackgroundHarness({
    translateImage: async (_provider, _document, image) => {
      started.push(image.id);
      await tail;
      return { ...image, fallbackText: 'Late image translation' };
    },
  });
  await worker.dispatch({ type: 'deep-research:translation-start', jobId: 'cancel-images', tabId: 1,
    context: { ...context(), blocks: [], images: [{ id: 'first' }, { id: 'second' }] },
  });
  await waitFor(() => started.length === 1);
  await worker.dispatch({ type: 'deep-research:translation-cancel', jobId: 'cancel-images' });
  release();
  await waitFor(async () => (await readerStore.getJob('cancel-images'))?.status === 'cancelled');
  assert.deepEqual(started, ['first']);
  assert.equal(worker.sent.filter(item => item.message.type === 'deep-research:apply-image-translations').length, 0);
});

test('worker records translation usage only after the job completes', async () => {
  globalThis.fetch = async () => completion();
  const worker = createBackgroundHarness();
  await worker.dispatch({ type: 'deep-research:translation-start', jobId: 'usage-complete', tabId: 1, context: context() });
  await waitFor(async () => (await readerStore.getJob('usage-complete'))?.status === 'completed', 3000);
  const usage = await waitFor(() => worker.chrome.storage.local.values.readerUsage, 3000);
  assert.equal(usage.totals.translation.requests, 1);
  assert.ok(usage.totals.translation.chars > 0);
  assert.ok(usage.totals.translation.tokens > 0);
});

test('worker records usage for an image-only translation', async () => {
  const image = { id: 'img-1', src: 'https://example.test/diagram.png', dataUrl: 'data:image/png;base64,AAAA', width: 320, height: 160, alt: 'diagram' };
  const worker = createBackgroundHarness({
    translateImage: async (_provider, _document, item) => ({ ...item, regions: [], fallbackText: '图示', confidence: 1 }),
  });
  await worker.dispatch({ type: 'deep-research:translation-start', jobId: 'usage-image', tabId: 1, context: { ...context('v-image'), blocks: [], images: [image] } });
  await waitFor(async () => (await readerStore.getJob('usage-image'))?.status === 'completed', 3000);
  const usage = await waitFor(() => worker.chrome.storage.local.values.readerUsage, 3000);
  assert.equal(usage.totals.translation.requests, 1);
});

test('worker does not record usage for a cancelled translation', async () => {
  globalThis.fetch = async (_url, options) => {
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const worker = createBackgroundHarness();
  await worker.dispatch({ type: 'deep-research:translation-start', jobId: 'usage-cancel', tabId: 1, context: context() });
  await waitFor(async () => (await readerStore.getJob('usage-cancel'))?.status === 'running', 3000);
  await worker.dispatch({ type: 'deep-research:translation-cancel', jobId: 'usage-cancel' });
  await waitFor(async () => (await readerStore.getJob('usage-cancel'))?.status === 'cancelled', 3000);
  assert.equal(worker.chrome.storage.local.values.readerUsage, undefined);
});

test('worker does not record usage when the job fails before translating', async () => {
  await readerStore.setSetting('provider', null);
  const worker = createBackgroundHarness();
  await worker.dispatch({ type: 'deep-research:translation-start', jobId: 'usage-fail', tabId: 1, context: context() });
  await waitFor(async () => (await readerStore.getJob('usage-fail'))?.status === 'failed', 5000);
  assert.equal(worker.chrome.storage.local.values.readerUsage, undefined);
});
