import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCAL_MODEL_CANDIDATES, detectLocalModels, pickLocalChatModel } from './local-models.js';

test('loopback candidates stay on localhost-style addresses', () => {
  assert.ok(LOCAL_MODEL_CANDIDATES.length >= 3);
  for (const candidate of LOCAL_MODEL_CANDIDATES) {
    const url = new URL(candidate.baseUrl);
    assert.equal(url.protocol, 'http:');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.ok(url.pathname.endsWith('/v1'));
  }
});

test('an embedding-only list still yields a usable default', () => {
  assert.equal(pickLocalChatModel(['nomic-embed-text']), 'nomic-embed-text');
  assert.equal(pickLocalChatModel(['bge-m3', 'qwen2.5-coder:7b']), 'qwen2.5-coder:7b');
  assert.equal(pickLocalChatModel([{ id: 'text-embedding-3-small' }, { id: 'llama3.2' }]), 'llama3.2');
  assert.equal(pickLocalChatModel([]), '');
});

test('detection keeps only reachable services and normalizes their models', async () => {
  const probed = [];
  const found = await detectLocalModels(async (baseUrl) => {
    probed.push(baseUrl);
    if (baseUrl.includes('11434')) return [{ id: 'nomic-embed-text' }, { id: 'qwen2.5-coder:7b' }];
    if (baseUrl.includes('1234')) return ['lmstudio-community/qwen2.5-7b'];
    throw new Error('offline');
  });
  assert.deepEqual(probed.slice().sort(), LOCAL_MODEL_CANDIDATES.map((item) => item.baseUrl).sort());
  assert.deepEqual(found.map((item) => item.id), ['ollama', 'lm-studio']);
  assert.equal(found[0].model, 'qwen2.5-coder:7b');
  assert.equal(found[0].count, 2);
  assert.equal(found[1].model, 'lmstudio-community/qwen2.5-7b');
});

test('an empty model list is not reported as a usable service', async () => {
  const found = await detectLocalModels(async () => []);
  assert.deepEqual(found, []);
});
