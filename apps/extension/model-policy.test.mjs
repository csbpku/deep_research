import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { modelRequestPolicy } from './model-policy.js';
import { explainSelection, requestChat, requestChatStream, translateBlocks, translateImage } from './reader-core.js';
import { readerStore } from './reader-store.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const provider = model => ({ baseUrl: 'https://policy.test/v1', model, apiKey: 'test', language: 'zh-CN' });
const completion = text => Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });

test('known reasoning models use compatible low-latency parameters for JSON and streams', async () => {
  for (const [model, effort, limit, temperature] of [
    ['grok-4.7', 'low', 'max_tokens', 0.2],
    ['grok-4.5', 'low', 'max_tokens', 0.2],
    ['MiniMax-M3.1-Flash', 'low', 'max_completion_tokens', 0.2],
    ['o3-mini', 'low', 'max_completion_tokens', undefined],
    ['gpt-5', 'low', 'max_completion_tokens', undefined],
    ['gpt-5.4', 'none', 'max_completion_tokens', undefined],
    ['deepseek-flash', 'low', 'max_tokens', 0.2],
    ['gemini-2.5-pro', 'low', 'max_tokens', 0.2],
    ['gemini-3-flash-preview', 'low', 'max_tokens', 0.2],
  ]) {
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (!body.stream) return completion('OK');
      return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    assert.equal((await requestChat(provider(model), [], { maxTokens: 5000 })).choices[0].message.content, 'OK');
    assert.equal(await requestChatStream(provider(model), [], { maxTokens: 5000 }), 'OK');
    for (const body of requests) {
      assert.equal(body.reasoning_effort, effort, model);
      assert.equal(body[limit], 5000, model);
      assert.equal(body.temperature, temperature, model);
      assert.equal('max_tokens' in body && 'max_completion_tokens' in body, false);
    }
  }
});

test('higher effort and provider defaults are honored for answers, while translations keep their fast policy', () => {
  assert.equal(modelRequestPolicy(provider('grok-4.7'), { reasoningMode: 'high' }).reasoningEffort, 'high');
  assert.equal(modelRequestPolicy(provider('grok-4.7'), { reasoningMode: 'provider' }).reasoningEffort, undefined);
  assert.equal(modelRequestPolicy(provider('grok-4.7'), { reasoningMode: 'high', purpose: 'translation' }).reasoningEffort, 'low');
  assert.equal(modelRequestPolicy(provider('grok-4.7'), { reasoningMode: 'high', action: 'translate' }).reasoningEffort, 'low');
  assert.equal(modelRequestPolicy(provider('deepseek-v4-pro'), { reasoningMode: 'medium' }).reasoningEffort, 'high');
  assert.equal(modelRequestPolicy(provider('gpt-5.4'), { reasoningMode: 'high' }).reasoningEffort, 'high');
});

test('unknown, non-reasoning, pro-only and native Claude models keep their previous request shape', async () => {
  for (const model of ['gpt-4o', 'gpt-5-pro', 'gpt-5.4-pro', 'o1-mini', 'o1-preview', 'grok-4', 'grok-4.20-multi-agent', 'deepseek-chat', 'custom-model']) {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.reasoning_effort, undefined, model);
      assert.equal(body.max_tokens, 5000, model);
      return completion('OK');
    };
    await requestChat(provider(model), [], { maxTokens: 5000, reasoningMode: 'high' });
  }
  const options = { maxTokens: 5000, reasoningMode: 'high' };
  assert.deepEqual(modelRequestPolicy({ ...provider('claude-sonnet-4-5'), providerKind: 'anthropic' }, options), options);
});

test('Messages-compatible MiniMax and DeepSeek use output_config for streaming and JSON requests', async () => {
  for (const model of ['MiniMax-M3.1', 'deepseek-flash']) {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.output_config, { effort: 'low' });
      assert.equal(body.max_tokens, 5000);
      assert.equal(body.reasoning_effort, undefined);
      return Response.json({ content: [{ type: 'text', text: 'OK' }] });
    };
    const config = { ...provider(model), providerKind: 'custom-anthropic' };
    await requestChat(config, [], { maxTokens: 5000 });
    assert.equal(await requestChatStream(config, [], { maxTokens: 5000 }), 'OK');
  }
});

test('batch, single-block fallback and high-detail image translation all use the fast policy', async () => {
  await readerStore.clearAll();
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (Array.isArray(body.messages.at(-1).content)) {
      return completion(JSON.stringify({ hasReadableText: true, confidence: 0.5, regions: [], fallbackTranslation: '图片译文' }));
    }
    if (body.messages.at(-1).content.includes('<<<TRANSLATION_BATCH>>>')) return completion('{}');
    return completion('忠实译文');
  };
  const config = provider('grok-4.7');
  const blocks = [{ id: 'a', text: 'A scheduler bounds work.' }, { id: 'b', text: 'A queue bounds memory.' }];
  const translated = await translateBlocks(config, { title: 'Queues' }, blocks);
  assert.equal(translated.length, 2);
  assert.ok(translated.every(item => item.text));
  const image = await translateImage(config, {}, { id: 'image', dataUrl: 'data:image/png;base64,AQID', width: 200, height: 100 });
  assert.equal(image.fallbackText, '图片译文');
  assert.equal(requests.length, 4);
  assert.ok(requests.every(body => body.reasoning_effort === 'low'));
  assert.equal(requests.at(-1).messages.at(-1).content[1].image_url.detail, 'high');
  assert.equal(requests.at(-1).max_tokens, 12000);
});

test('reading answers request readable paragraphs and preserve the model line breaks', async () => {
  const answer = '## Result\n\nFirst short paragraph.\n\n- One point\n- Another point';
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.match(request.messages[0].content, /separate distinct ideas with blank lines/u);
    assert.match(request.messages[0].content, /\\n\\n/u);
    return completion(JSON.stringify({ answer, evidence: [], limitations: [] }));
  };
  const result = await explainSelection(provider('grok-4.7'), { url: 'https://example.test/', body: 'A bounded queue preserves capacity.' }, 'Explain the queue.');
  assert.equal(result.answer, answer);
});
