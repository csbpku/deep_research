import assert from 'node:assert/strict';
import test from 'node:test';
import { isBundledDemoUrl, requestDemoContext } from './reader-demo.js';

const demoUrl = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/demo.html';

test('only the bundled demo in this extension bypasses script injection', () => {
  assert.equal(isBundledDemoUrl(demoUrl, demoUrl), true);
  assert.equal(isBundledDemoUrl(`${demoUrl}?tour=1#queue`, demoUrl), true);
  for (const value of [
    '', null, undefined, 'not a URL',
    'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/demo.html',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel.html',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/demo.html/other',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/demo.html.js',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop:123/demo.html',
    'chrome-extension://user@abcdefghijklmnopabcdefghijklmnop/demo.html',
    'https://abcdefghijklmnopabcdefghijklmnop/demo.html',
    'file:///demo.html',
  ]) assert.equal(isBundledDemoUrl(value, demoUrl), false, String(value));
  assert.equal(isBundledDemoUrl('https://example.org/demo.html', 'https://example.org/demo.html'), false);
  assert.equal(isBundledDemoUrl(demoUrl, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel.html'), false);
  assert.equal(isBundledDemoUrl('chrome-extension:///demo.html', 'chrome-extension:///demo.html'), false);
  assert.equal(isBundledDemoUrl(demoUrl, ''), false);
});

test('demo handshake waits for its self-loaded listener and accepts an undefined reply', async () => {
  const calls = [];
  const ready = await requestDemoContext(17, {
    attempts: 5, delayMs: 0,
    sendMessage: async (...args) => {
      calls.push(args);
      if (calls.length < 3) throw new Error('Receiving end does not exist');
    },
  });
  assert.equal(ready, true);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => [17, { type: 'deep-research:request-page' }]));
});

test('failed demo activation exhausts its bounded retry count', async () => {
  let calls = 0;
  assert.equal(await requestDemoContext(0, {
    attempts: 3, delayMs: 0,
    sendMessage: () => { calls += 1; throw new Error('not listening'); },
  }), false);
  assert.equal(calls, 3);
});

test('invalid tabs and transports do not send a message', async () => {
  let calls = 0;
  const sendMessage = async () => { calls += 1; };
  for (const id of [undefined, null, -1, 1.5, '17']) {
    assert.equal(await requestDemoContext(id, { sendMessage }), false);
  }
  assert.equal(await requestDemoContext(17), false);
  assert.equal(await requestDemoContext(17, { sendMessage, attempts: 0 }), false);
  assert.equal(calls, 0);
});

test('an unresponsive message channel cannot leave activation pending', { timeout: 1000 }, async () => {
  let release;
  let calls = 0;
  const started = Date.now();
  const ready = await requestDemoContext(17, {
    attempts: 3, delayMs: 10,
    sendMessage: () => { calls += 1; return new Promise((resolve) => { release = resolve; }); },
  });
  assert.equal(ready, false);
  assert.ok(Date.now() - started < 500, 'activation exceeds its configured retry budget');
  release();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 1, 'settling a timed-out channel must not start more retries');
});

test('a fulfilled handshake stops immediately instead of repeating page requests', async () => {
  let calls = 0;
  assert.equal(await requestDemoContext(17, {
    attempts: 20, delayMs: 0,
    sendMessage: async () => { calls += 1; return { ok: true }; },
  }), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
});
