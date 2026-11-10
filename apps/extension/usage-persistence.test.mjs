import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageRecorder } from './usage-persistence.js';
import { USAGE_KEY, recordUsage, usageSummary } from './usage-meter.js';

const TODAY = new Date(2026, 10, 10, 12);
const options = { now: () => TODAY };

function memoryStorage(initial) {
  let value = structuredClone(initial);
  return {
    get value() { return structuredClone(value); },
    async get(key) {
      assert.equal(key, USAGE_KEY);
      return { [key]: structuredClone(value) };
    },
    async set(update) {
      assert.deepEqual(Object.keys(update), [USAGE_KEY]);
      value = structuredClone(update[USAGE_KEY]);
    },
  };
}

test('independent callers keep both events while the first storage write is pending', async () => {
  const storage = memoryStorage();
  const normalGet = storage.get.bind(storage);
  const normalSet = storage.set.bind(storage);
  let reads = 0;
  let writes = 0;
  let markFirstWrite;
  let releaseFirstWrite;
  const firstWriting = new Promise(resolve => { markFirstWrite = resolve; });
  const firstWriteAllowed = new Promise(resolve => { releaseFirstWrite = resolve; });
  storage.get = async key => { reads += 1; return normalGet(key); };
  storage.set = async update => {
    writes += 1;
    if (writes === 1) {
      markFirstWrite();
      await firstWriteAllowed;
    }
    await normalSet(update);
  };
  const record = createUsageRecorder(storage, options);
  const translationCaller = () => record({ kind: 'translation', requests: 1, chars: 100, tokens: 40 });
  const answerCaller = () => record({ kind: 'answer', requests: 1, chars: 30, tokens: 20 });

  const first = translationCaller();
  await firstWriting;
  const second = answerCaller();
  await new Promise(resolve => setImmediate(resolve));
  const readsWhileFirstWritePending = reads;
  releaseFirstWrite();
  const [, result] = await Promise.all([first, second]);

  assert.equal(readsWhileFirstWritePending, 1, 'the second caller must wait until the first write commits');
  assert.equal(reads, 2, 'each event reads the current stored counters');
  assert.deepEqual(result.totals, {
    translation: { requests: 1, chars: 100, tokens: 40 },
    answer: { requests: 1, chars: 30, tokens: 20 },
  });
  assert.deepEqual(storage.value, result);
  assert.equal(usageSummary(result).requests, 2);
});

for (const phase of ['get', 'set']) {
  test(`a failed storage ${phase} rejects its caller without blocking the next queued event`, async () => {
    const storage = memoryStorage();
    const normal = storage[phase].bind(storage);
    let calls = 0;
    storage[phase] = async value => {
      calls += 1;
      if (calls === 1) throw new Error(`failed ${phase}`);
      return normal(value);
    };
    const record = createUsageRecorder(storage, options);
    const results = await Promise.allSettled([
      record({ kind: 'translation', requests: 1 }),
      record({ kind: 'answer', requests: 1, chars: 12, tokens: 5 }),
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.match(results[0].reason.message, new RegExp(`failed ${phase}`));
    assert.equal(results[1].status, 'fulfilled');
    assert.deepEqual(storage.value.totals, {
      translation: { requests: 0, chars: 0, tokens: 0 },
      answer: { requests: 1, chars: 12, tokens: 5 },
    });
  });
}

test('recording prunes old days and persists only counters using the local event day', async () => {
  const initial = recordUsage(null, { day: '2026-06-01', requests: 90 });
  initial.days['2026-11-09'] = {
    answer: { requests: 1, chars: 10, tokens: 4, url: 'https://private.invalid/', apiKey: 'secret-key' },
  };
  initial.model = 'private-model';
  const storage = memoryStorage(initial);
  const record = createUsageRecorder(storage, options);
  const result = await record({
    kind: 'translation', requests: 1, chars: 20, tokens: 7,
    text: 'secret page text', url: 'https://private.invalid/', model: 'private-model', apiKey: 'secret-key',
  });

  assert.deepEqual(Object.keys(result.days), ['2026-11-09', '2026-11-10']);
  assert.deepEqual(result.days['2026-11-10'].translation, { requests: 1, chars: 20, tokens: 7 });
  assert.deepEqual(result.totals.answer, { requests: 1, chars: 10, tokens: 4 });
  assert.doesNotMatch(JSON.stringify(storage.value), /private|secret|apiKey|model|url|text/);
});
