import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundHarness } from './test-helpers/background-runtime.mjs';

test('the real background message handler preserves simultaneous events from separate panels', async () => {
  const worker = createBackgroundHarness();
  const [translation, answer] = await Promise.all([
    worker.dispatch({ type: 'deep-research:record-usage', event: { kind: 'translation', requests: 1, chars: 10, tokens: 4, url: 'private-url' } }),
    worker.dispatch({ type: 'deep-research:record-usage', event: { kind: 'answer', requests: 1, chars: 20, tokens: 8, apiKey: 'private-key' } }),
  ]);
  assert.equal(translation.ok, true);
  assert.equal(answer.ok, true);
  const usage = worker.chrome.storage.local.values.readerUsage;
  assert.equal(usage.totals.translation.requests, 1);
  assert.equal(usage.totals.answer.requests, 1);
  assert.ok(!JSON.stringify(usage).includes('private-'));
});

test('a malformed usage message gets a response without a counter write', async () => {
  const worker = createBackgroundHarness();
  const result = await worker.dispatch({ type: 'deep-research:record-usage', event: null });
  assert.equal(result.ok, false);
  assert.equal(worker.chrome.storage.local.values.readerUsage, undefined);
});
