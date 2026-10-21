import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchProviderModels, isLoopbackEndpoint, modelConnectionError, modelResponseError, normalizeModelBaseUrl, validateModelConnection } from './model-connection.js';

const provider = { providerKind: 'custom', baseUrl: 'https://models.example/v1', apiKey: 'fixture-key', model: 'chat-model' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('pasted completion, messages and models URLs resolve to the same API root', () => {
  for (const ending of ['', '/', '///', '/models', '/messages/', '/chat/completions']) {
    assert.equal(normalizeModelBaseUrl(`https://models.example/v1${ending}`), 'https://models.example/v1');
  }
  assert.equal(normalizeModelBaseUrl('http://localhost:11434', 'ollama'), 'http://localhost:11434/v1');
  assert.equal(normalizeModelBaseUrl('http://127.0.0.1:1234/', 'lm-studio'), 'http://127.0.0.1:1234/v1');
  assert.equal(normalizeModelBaseUrl('http://localhost:11434/api', 'ollama'), 'http://localhost:11434/v1');
  assert.equal(normalizeModelBaseUrl('https://proxy.example/gateway'), 'https://proxy.example/gateway');
});

test('invalid addresses and URL credentials fail before requesting any origin', () => {
  for (const value of ['', 'localhost:1234', 'file:///tmp/model', 'https://user:secret@example.com/v1', 'https://models.example/v1?key=secret']) {
    assert.throws(() => normalizeModelBaseUrl(value), error => error.code === 'ADDRESS' && error.field === 'provider-url');
  }
});

test('missing cloud key is a field error; only actual loopback services may omit it', () => {
  assert.throws(() => validateModelConnection({ ...provider, apiKey: ' ' }), error => error.code === 'KEY_REQUIRED' && error.field === 'provider-key');
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(isLoopbackEndpoint(`http://${host}:1234/v1`), true);
    assert.equal(validateModelConnection({ ...provider, baseUrl: `http://${host}:1234/v1`, apiKey: '' }).apiKey, '');
  }
  for (const host of ['localhost.example.com', '127.0.0.1.example.com', '192.168.1.5']) assert.equal(isLoopbackEndpoint(`http://${host}/v1`), false);
  assert.throws(() => validateModelConnection({ ...provider, model: ' ' }, { requireModel: true }), error => error.code === 'MODEL_REQUIRED');
});

test('model discovery handles paging, duplicate IDs and provider display names', async () => {
  const requests = [];
  const models = await fetchProviderModels(provider, { authorization: 'Bearer fixture-key', 'content-type': 'application/json' }, {
    fetch: async (url, options) => {
      requests.push({ url: new URL(url), headers: options.headers });
      return requests.length === 1
        ? json({ data: [{ id: 'b', display_name: 'Beta' }, { id: 'a' }], has_more: true, last_id: 'b' })
        : json({ data: [{ id: 'a' }, { id: 'c' }], has_more: false });
    },
  });
  assert.deepEqual(models.map(m => m.id), ['a', 'b', 'c']);
  assert.equal(models[1].label, 'Beta');
  assert.equal(requests[1].url.searchParams.get('after_id'), 'b');
  assert.equal(requests[0].headers.authorization, 'Bearer fixture-key');
  assert.equal('content-type' in requests[0].headers, false);
});

test('OpenAI, Anthropic and native model-list shapes are accepted', async () => {
  for (const payload of [{ data: ['one', 'two'] }, { data: [{ id: 'one', display_name: 'One' }, { id: 'two' }] }, { models: [{ model: 'one' }, { name: 'two' }] }, ['one', 'two']]) {
    const models = await fetchProviderModels(provider, {}, { fetch: async () => json(payload) });
    assert.deepEqual(models.map(m => m.id), ['one', 'two']);
  }
});

test('authorization, unsupported list, rate limit and server failure have distinct recovery states', async () => {
  for (const [status, code, field] of [[401, 'AUTH', 'provider-key'], [403, 'AUTH', 'provider-key'], [404, 'MODELS_UNSUPPORTED', 'provider-url'], [405, 'MODELS_UNSUPPORTED', 'provider-url'], [429, 'RATE_LIMIT', ''], [503, 'SERVICE', '']]) {
    await assert.rejects(fetchProviderModels(provider, {}, { fetch: async () => json({ error: { message: 'must-not-echo-fixture-key' } }, status) }), error => error.code === code && error.field === field && !error.message.includes('fixture-key'));
  }
});

test('HTML landing pages, malformed data and empty inventories do not masquerade as a usable connection', async () => {
  await assert.rejects(fetchProviderModels(provider, {}, { fetch: async () => new Response('<html>Not an API</html>') }), error => error.code === 'RESPONSE');
  await assert.rejects(fetchProviderModels(provider, {}, { fetch: async () => json({ message: 'OK' }) }), error => error.code === 'RESPONSE');
  await assert.rejects(fetchProviderModels(provider, {}, { fetch: async () => json({ data: [] }) }), error => error.code === 'EMPTY_MODELS');
});

test('a timed-out discovery has an actionable error rather than a raw AbortError', async () => {
  await assert.rejects(fetchProviderModels(provider, {}, {
    timeoutMs: 10,
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  }), error => error.code === 'TIMEOUT' && error.field === 'provider-url');
});

test('editing a connection can cancel its pending discovery without converting cancellation to a network failure', async () => {
  const controller = new AbortController();
  const result = fetchProviderModels(provider, {}, {
    signal: controller.signal,
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  });
  controller.abort();
  await assert.rejects(result, error => error.name === 'AbortError');
});

test('network errors point to address/access recovery and provider messages cannot echo credentials', () => {
  assert.equal(modelConnectionError(new TypeError('Failed to fetch'), provider).code, 'NETWORK');
  assert.equal(modelConnectionError(new Error('Rejected fixture-key'), provider).message, 'Rejected [已隐藏]');
});

test('model inference authentication errors distinguish a responding local proxy from a cloud Key error', () => {
  const local = modelResponseError(401, 'private provider details', { baseUrl: 'http://127.0.0.1:8317/v1', apiKey: '' });
  assert.match(local.message, /本地服务已响应/);
  assert.equal(local.field, 'provider-model-list');
  const cloud = modelResponseError(401, 'private provider details', provider);
  assert.equal(cloud.field, 'provider-key');
  assert.equal(modelResponseError(400, 'Rejected fixture-key', provider).message, 'Rejected [已隐藏]');
});
