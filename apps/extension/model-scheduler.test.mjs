import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createModelScheduler, retryDelay } from './model-scheduler.js';
import { requestChat, requestChatStream, translateBlocks } from './reader-core.js';
import { readerStore } from './reader-store.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const provider = name => ({ baseUrl: `https://${name}.test/v1`, model: 'test-model', apiKey: 'test' });
const completion = () => Response.json({ choices: [{ message: { content: 'OK' } }] });

test('interactive calls use the reserved slot while background work remains bounded', async () => {
  const scheduler = createModelScheduler();
  const holds = Array.from({ length: 5 }, gate);
  const started = [];
  const jobs = holds.map((hold, i) => scheduler.run('same', async () => { started.push(i); await hold.promise; }, { priority: 'background' }));
  try {
    await turn();
    assert.deepEqual(started, [0, 1, 2]);
    await scheduler.run('same', () => { started.push('answer'); });
    assert.deepEqual(started, [0, 1, 2, 'answer']);
    const queuedAnswer = scheduler.run('same', () => { started.push('next-answer'); });
    holds[0].resolve();
    await queuedAnswer;
    assert.ok(started.indexOf('next-answer') < started.indexOf(3) || !started.includes(3));
  } finally { holds.forEach(hold => hold.resolve()); await Promise.all(jobs); }
});

test('queued cancellation removes a request without calling its provider', async () => {
  const scheduler = createModelScheduler({ maxConcurrent: 1, maxBackground: 1 });
  const hold = gate();
  const active = scheduler.run('same', () => hold.promise);
  const controller = new AbortController();
  let called = false;
  const pending = scheduler.run('same', () => { called = true; }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  hold.resolve();
  await active;
  assert.equal(called, false);
});

test('429 cooldown is shared by models on the endpoint and leaves other endpoints available', async () => {
  const scheduler = createModelScheduler();
  const started = [];
  const beginning = Date.now();
  scheduler.cooldown('same', 35);
  const delayed = scheduler.run('same', () => { started.push('delayed'); assert.ok(Date.now() - beginning >= 30); });
  await scheduler.run('other', () => { started.push('other'); });
  assert.deepEqual(started, ['other']);
  await delayed;
  assert.deepEqual(started, ['other', 'delayed']);
  assert.equal(retryDelay(new Headers({ 'retry-after': '2' }), 0), 2000);
  assert.equal(retryDelay(new Headers({ 'retry-after': new Date(10_000).toUTCString() }), 0, 6000), 4000);
  assert.ok(retryDelay(new Headers(), 1) >= 2000);
});

test('a transient 429 retries the same batch, instead of fanning out to individual paragraphs', async () => {
  await readerStore.clearAll();
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1) return Response.json({ error: { message: 'limited' } }, { status: 429, headers: { 'retry-after': '0.02' } });
    const blocks = JSON.parse(body.messages.at(-1).content.split('<<<TRANSLATION_BATCH>>>\n')[1]).blocks;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ translations: blocks.map(item => ({ id: item.id, text: '译文' })) }) } }] });
  };
  const results = await translateBlocks(provider('retry-batch'), {}, [{ id: 'a', text: 'First source' }, { id: 'b', text: 'Second source' }]);
  assert.ok(results.every(item => item.text));
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
});

test('persistent 429 stops a translation after bounded retries without paragraph fan-out', async () => {
  await readerStore.clearAll();
  let count = 0;
  globalThis.fetch = async () => { count += 1; return new Response('{}', { status: 429, headers: { 'retry-after': '0' } }); };
  await assert.rejects(translateBlocks(provider('quota'), {}, [{ id: 'a', text: 'First source' }, { id: 'b', text: 'Second source' }]), { status: 429 });
  assert.equal(count, 3);
});

test('cancellation during Retry-After never resends, and long quota waits fail without immediate retry', async () => {
  const controller = new AbortController();
  let count = 0;
  globalThis.fetch = async () => {
    count += 1;
    queueMicrotask(() => controller.abort());
    return new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
  };
  await assert.rejects(requestChat(provider('cancel-retry'), [], { signal: controller.signal }));
  assert.equal(count, 1);
  globalThis.fetch = async () => { count += 1; return new Response('{}', { status: 429, headers: { 'retry-after': '120' } }); };
  await assert.rejects(requestChat(provider('long-quota'), []), { status: 429 });
  assert.equal(count, 2);
});

test('streaming holds its slot until the last frame, and a broken stream is never replayed', async () => {
  const hold = gate();
  const jsonHold = gate();
  let count = 0;
  globalThis.fetch = async () => {
    count += 1;
    if (count > 1) { await jsonHold.promise; return completion(); }
    return new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        await hold.promise;
        controller.error(new Error('stream interrupted'));
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const config = provider('stream-slots');
  const deltas = [];
  const streaming = requestChatStream(config, [], { onDelta: text => deltas.push(text), priority: 'background' });
  const others = Array.from({ length: 3 }, () => requestChat(config, [], { priority: 'background' }));
  await turn();
  // Three background slots: the open stream and two blocked JSON calls.
  // The last JSON call cannot start merely because stream headers arrived.
  assert.equal(count, 3);
  assert.deepEqual(deltas, ['partial']);
  const rejected = assert.rejects(streaming, /stream interrupted/u);
  hold.resolve();
  await rejected;
  await turn();
  assert.equal(count, 4);
  jsonHold.resolve();
  await Promise.all(others);
});
