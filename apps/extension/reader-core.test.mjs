import test from 'node:test';
import assert from 'node:assert/strict';

import { boundTaskContext, buildAnnotationUrl, cleanTranslationText, explainImage, explainSelection, loadProvider, mergeProcessedIds, mergeTranslationFailures, parseReadingAnswer, providerReady, requestChat, requestChatStream, saveProvider, stripReasoningText, testVisionProvider, translateBlocks, translateImage } from './reader-core.js';
import { readerStore } from './reader-store.js';

test('provider readiness requires address, model and key', () => {
  assert.equal(providerReady({ baseUrl: 'https://example.com/v1', model: 'm', apiKey: 'k' }), true);
  assert.equal(providerReady({ baseUrl: 'https://example.com/v1', model: 'm', apiKey: '' }), false);
});

test('translation output removes prompt labels without deleting real content', () => {
  assert.equal(cleanTranslationText('页面标题：AI 原生 SDLC 实战手册 | Anthropic 的 Claude 原文翻译。'), '');
  assert.equal(cleanTranslationText('页面标题：Docs\n\n译文：这是正文。'), '这是正文。');
  assert.equal(cleanTranslationText('原文：Hello\n译文：你好'), '你好');
  assert.equal(cleanTranslationText('原文中提到的边界条件需要保留。'), '原文中提到的边界条件需要保留。');
});

test('annotation return URL preserves existing query and fragment', () => {
  const url = buildAnnotationUrl('https://example.com/docs?lang=zh#section-2', { quote: 'bounded queue' });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('lang'), 'zh');
  assert.equal(parsed.hash, '#section-2');
  assert.deepEqual(JSON.parse(parsed.searchParams.get('deep-research-anchor')), { quote: 'bounded queue' });
});

test('provider settings reject non-HTTP model endpoints', async () => {
  await assert.rejects(
    () => saveProvider({ baseUrl: 'file:///tmp/model', model: 'm', apiKey: 'k' }),
    /HTTP\(S\)/u,
  );
});

test('provider settings use one model and migrate legacy fields on read', async () => {
  const saved = await saveProvider({
    providerKind: 'minimax',
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M3',
    visionModel: 'legacy-vision-model',
    language: 'ja-JP',
    apiKey: 'secret',
  });
  assert.equal(saved.model, 'MiniMax-M3');
  assert.equal(Object.hasOwn(saved, 'visionModel'), false);
  assert.equal(Object.hasOwn(saved, 'language'), false);

  await readerStore.setSetting('provider', {
    baseUrl: 'https://example.com/v1',
    visionModel: 'legacy-only-model',
    apiKey: 'secret',
  });
  const migrated = await loadProvider();
  assert.equal(migrated.model, 'legacy-only-model');
  assert.equal(Object.hasOwn(migrated, 'visionModel'), false);
});

test('vision capability check requires reading a marker from the image', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const system = body.messages.find((item) => item.role === 'system')?.content || '';
    return new Response(JSON.stringify({ choices: [{ message: { content: system.includes('视觉能力检查器') ? 'READER_VISION_CHECK' : 'OK' } }] }), { status: 200 });
  };
  try {
    const provider = { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret' };
    assert.equal((await testVisionProvider(provider)).includes('READER_VISION_CHECK'), true);
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
    await assert.rejects(() => testVisionProvider(provider), /未能可靠读取图片文字/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('vision capability check times out without blocking text setup', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  try {
    await assert.rejects(
      () => testVisionProvider({ baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret' }, { timeoutMs: 5 }),
      /视觉能力检查超时（5ms）/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI-compatible request sends the configured model and returns payload', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const payload = await requestChat({ baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret' }, [
      { role: 'user', content: 'ping' },
    ]);
    assert.equal(payload.choices[0].message.content, 'OK');
    assert.equal(request.url, 'https://example.com/v1/chat/completions');
    assert.equal(JSON.parse(request.options.body).model, 'reader-model');
    assert.equal(request.options.headers.authorization, 'Bearer secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic Messages request converts system and image messages', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const payload = await requestChat({
      providerKind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
      apiKey: 'secret',
    }, [
      { role: 'system', content: 'Follow the reader contract.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read this image.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', detail: 'high' } },
        ],
      },
    ]);
    const body = JSON.parse(request.options.body);
    assert.equal(payload.content[0].text, 'OK');
    assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(request.options.headers['x-api-key'], 'secret');
    assert.equal(request.options.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.options.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(body.model, 'claude-sonnet-4-5');
    assert.equal(body.system, 'Follow the reader contract.');
    assert.equal(body.messages.some((item) => item.role === 'system'), false);
    assert.equal(body.messages[0].content[0].text, 'Read this image.');
    assert.deepEqual(body.messages[0].content[1], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AQID' },
    });
    assert.equal(body.max_tokens, 4096);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI-compatible streaming responses emit deltas in order', async () => {
  const originalFetch = globalThis.fetch;
  const deltas = [];
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response([
      'data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const answer = await requestChatStream(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret' },
      [{ role: 'user', content: 'ping' }],
      { onDelta: (text) => deltas.push(text) },
    );
    assert.equal(answer, '第一段第二段');
    assert.deepEqual(deltas, ['第一段', '第二段']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic streaming responses emit text deltas in order', async () => {
  const originalFetch = globalThis.fetch;
  const deltas = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.stream, true);
    return new Response([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"第一段"}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"第二段"}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const answer = await requestChatStream(
      { providerKind: 'custom-anthropic', baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret' },
      [{ role: 'user', content: 'ping' }],
      { onDelta: (text) => deltas.push(text) },
    );
    assert.equal(answer, '第一段第二段');
    assert.deepEqual(deltas, ['第一段', '第二段']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streaming request falls back to a blocking JSON response when the provider ignores stream', async () => {
  const originalFetch = globalThis.fetch;
  const deltas = [];
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'blocking fallback' } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const answer = await requestChatStream(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret' },
      [{ role: 'user', content: 'ping' }],
      { onDelta: (text) => deltas.push(text) },
    );
    assert.equal(answer, 'blocking fallback');
    assert.deepEqual(deltas, ['blocking fallback']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streaming and blocking responses hide provider reasoning tags, including split tags', async () => {
  assert.equal(stripReasoningText('<think>private</think>visible'), 'visible');
  assert.equal(stripReasoningText('<analysis>private without close'), '');
  const originalFetch = globalThis.fetch;
  const deltas = [];
  globalThis.fetch = async (_url, options) => {
    if (JSON.parse(options.body).stream) {
      return new Response([
        'data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"nk>private</think>visible"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '<analysis>private</analysis>visible' } }] }), { status: 200 });
  };
  try {
    const streamed = await requestChatStream({ baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret' }, [{ role: 'user', content: 'ping' }], { onDelta: (text) => deltas.push(text) });
    assert.equal(streamed, 'visible');
    assert.equal(deltas.join(''), 'visible');
    const blocked = await explainSelection(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret' },
      { title: 'Docs', url: 'https://example.com/docs', body: 'visible' },
    );
    assert.equal(blocked.answer, 'visible');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('whole-page questions select a bounded relevant context and disclose coverage', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'bounded answer', evidence: [] }) } }] }), { status: 200 });
  };
  try {
    const body = `${'intro '.repeat(20_000)}\n\n${'queue capacity relevant '.repeat(2_000)}\n\n${'tail '.repeat(20_000)}`;
    const result = await explainSelection(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret' },
      { url: 'https://example.com/docs', title: 'Long docs', body },
      'queue capacity',
    );
    const userContent = request.messages.at(-1).content;
    assert.ok(userContent.length < 100_000);
    assert.match(userContent, /queue capacity relevant/u);
    assert.ok(result.warnings.some((warning) => /只覆盖与问题相关/u.test(warning)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('code blocks are preserved and never sent to the translation model', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    assert.match(body.messages[1].content, /prose/u);
    return new Response(JSON.stringify({ choices: [{ message: { content: '译文' } }] }), { status: 200 });
  };
  try {
    const result = await translateBlocks(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      [{ id: 'p', text: 'prose', kind: 'text' }, { id: 'code', text: 'const x = 1;', kind: 'code' }],
    );
    assert.equal(calls, 1);
    assert.equal(result.find((item) => item.id === 'code').skipped, true);
    assert.equal(result.find((item) => item.id === 'code').text, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('text translations are emitted as soon as each block completes', async () => {
  const originalFetch = globalThis.fetch;
  const completed = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const source = body.messages.at(-1).content;
    const delay = source.includes('slow') ? 25 : 0;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return new Response(JSON.stringify({ choices: [{ message: { content: source.includes('slow') ? '慢段' : '快段' } }] }), { status: 200 });
  };
  try {
    const result = await translateBlocks(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      [{ id: 'slow', text: 'slow', kind: 'text' }, { id: 'fast', text: 'fast', kind: 'text' }],
      { concurrency: 2, onResult: (item) => completed.push(item.id) },
    );
    assert.deepEqual(completed, ['fast', 'slow']);
    assert.deepEqual(result.map((item) => item.text), ['快段', '慢段']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('image translation forwards cancellation and reuses the local result cache', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let receivedSignal;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    receivedSignal = options.signal;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ regions: [{ text: 'Hello', translation: '你好', x: 1, y: 2, width: 20, height: 10 }], confidence: 0.9, note: '' }) } }] }), { status: 200 });
  };
  try {
    const controller = new AbortController();
    const provider = { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' };
    const image = { id: 'image-1', src: 'https://example.com/image.png', width: 100, height: 80 };
    const first = await translateImage(provider, { title: 'Test' }, image, { signal: controller.signal });
    const second = await translateImage(provider, { title: 'Test' }, image, { signal: controller.signal });
    assert.equal(calls, 1);
    assert.equal(receivedSignal, controller.signal);
    assert.deepEqual(second.regions, first.regions);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('vision-unavailable images stay original without becoming retryable failures', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('image request must not be sent');
  };
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'text-only', apiKey: 'secret', visionReady: false, language: 'zh-CN' },
      { title: 'Test' },
      { id: 'vision-unavailable', src: 'https://example.com/diagram.png', width: 400, height: 200, status: 'ready' },
    );
    assert.equal(calls, 0);
    assert.equal(result.skipped, true);
    assert.equal(result.keptOriginal, true);
    assert.equal(result.regions.length, 0);
    assert.equal(result.fallbackText, '');
    assert.match(result.note, /保留原图/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('image translation accepts a valid JSON object wrapped in provider prose', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '<think>示例路径为 /v1/payment_intents/{id}。</think>\n结果如下：```json\n{"regions":[{"text":"Queue {A}","translation":"队列 {A}","x":1,"y":2,"width":120,"height":40}],"confidence":0.9,"note":""}\n```\n补充说明：示例中的 } 不是新的结果。' } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'wrapped-json', src: 'https://example.com/wrapped-json-image.png', width: 200, height: 100, status: 'ready' },
    );
    assert.equal(result.regions.length, 1);
    assert.equal(result.regions[0].translation, '队列 {A}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('image translation follows the configured target language', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      regions: [{ text: 'Hello', translation: 'Bonjour', x: 1, y: 2, width: 20, height: 10 }],
      confidence: 0.9,
      note: '',
    }) } }] }), { status: 200 });
  };
  try {
    await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'fr-FR' },
      { title: 'Test' },
      { id: 'language-image', src: 'https://example.com/image.png', width: 100, height: 80, status: 'ready' },
    );
    assert.match(request.messages[0].content, /fr-FR/u);
    assert.doesNotMatch(request.messages[0].content, /翻译成中文/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('image translation can read a permitted cross-origin image before sending it to the model', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options = {}) => {
    if (options.body) {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ regions: [{ text: 'Hello', translation: '你好', x: 1, y: 2, width: 20, height: 10 }], confidence: 0.9, note: '' }) } }] }), { status: 200 });
    }
    requests.push({ image: true });
    return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
  };
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'remote-image', src: 'https://images.example.com/diagram.png', width: 100, height: 80, status: 'ready' },
      { fetchImageBytes: true },
    );
    assert.equal(result.regions.length, 1);
    assert.equal(requests[0].image, true);
    assert.equal(requests[1].messages[1].content.some((part) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,')), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unloaded images fail explicitly instead of being silently skipped', async () => {
  await assert.rejects(
    () => translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'pending', src: 'https://example.com/lazy.png', width: 0, height: 0, status: 'pending' },
    ),
    /尚未加载/u,
  );
});

test('low-confidence image OCR keeps a side translation instead of covering the original', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      regions: [{ text: 'tiny', translation: '不可靠', x: 1, y: 2, width: 20, height: 10 }],
      confidence: 0.5,
      fallbackTranslation: '这张图展示一个队列处理流程。',
      note: '',
    }) } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'fallback', src: 'https://example.com/fallback.png', width: 320, height: 180, status: 'ready' },
    );
    assert.deepEqual(result.regions, []);
    assert.equal(result.fallbackText, '这张图展示一个队列处理流程。');
    assert.equal(result.fallbackRegions.length, 1);
    assert.deepEqual(result.fallbackRegions[0], { text: 'tiny', translation: '不可靠', x: 1, y: 2, width: 20, height: 10 });
    assert.match(result.note, /旁侧译文/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('empty image fallback labels are discarded instead of rendered as blank fields', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      regions: [],
      confidence: 0.4,
      fallbackTranslation: '原文：\n译文：',
      note: '',
    }) } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'blank-fallback', src: 'https://example.com/image.png', width: 320, height: 180, status: 'ready' },
    );
    assert.equal(result.fallbackText, '');
    assert.equal(result.fallbackRegions.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('high-confidence no-text images are completed without being marked for retry', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
    // A no-text classification is terminal and must not trigger the
    // ambiguous-result retry path.
    choices: [{ message: { content: JSON.stringify({
      hasReadableText: false,
      regions: [],
      confidence: 0.96,
      fallbackTranslation: '',
      note: '图片为装饰照片，没有可读文字。',
    }) } }],
    }), { status: 200 });
  };
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'no-text-image', src: 'https://example.com/no-text-image.png', width: 100, height: 80, status: 'ready' },
    );
    assert.equal(result.noText, true);
    assert.equal(result.regions.length, 0);
    assert.equal(result.fallbackText, '');
    // A no-text answer is confirmed once so a screenshot is not silently
    // classified as a decorative photo on the first vision pass.
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('repeated low-confidence no-text answers remain retryable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      hasReadableText: false,
      regions: [],
      confidence: 0.85,
      fallbackTranslation: '',
      note: '可能没有可读文字。',
    }) } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'low-confidence-no-text-repeat', src: 'https://example.com/uncertain.png', width: 640, height: 360, status: 'ready' },
    );
    assert.equal(result.noText, false);
    assert.equal(result.keptOriginal, false);
    assert.match(result.note, /重试|未自动覆盖|未识别/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unchanged technical identifiers stay in the original image without uncertain overlays', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      regions: [
        { text: 'MyApp', translation: 'MyApp（我的应用）', x: 80, y: 20, width: 260, height: 100 },
        { text: 'count', translation: 'count（计数）', x: 90, y: 120, width: 160, height: 60 },
      ],
      confidence: 0.98,
      fallbackTranslation: '',
      note: '',
    }) } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'identifiers-only', src: 'https://example.com/diagram.png', width: 640, height: 360, status: 'ready' },
    );
    assert.equal(result.regions.length, 0);
    assert.equal(result.fallbackText, '');
    assert.equal(result.keptOriginal, true);
    assert.match(result.note, /保留原文/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('high-confidence technical-only notes keep the original image without retry', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      regions: [],
      confidence: 0.97,
      note: '图中文字均为代码标识符与数值，按规则保留原文不做翻译。',
    }) } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Code diagram' },
      { id: 'technical-note-only', src: 'https://example.com/technical-note-only.png', width: 640, height: 360, status: 'ready' },
    );
    assert.equal(result.keptOriginal, true);
    assert.equal(result.noText, false);
    assert.equal(result.fallbackText, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('image OCR maps downscaled model coordinates back to source pixels', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      regions: [{ text: 'Label', translation: '标签', x: 100, y: 50, width: 50, height: 20 }],
      confidence: 0.95,
      note: '',
    }) } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'scaled-image', src: 'https://example.com/scaled.png', width: 2_000, height: 1_000, modelWidth: 1_000, modelHeight: 500, status: 'ready' },
    );
    assert.deepEqual(result.regions[0], { text: 'Label', translation: '标签', x: 200, y: 100, width: 100, height: 40 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('low-confidence no-text answers remain visible retryable results', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        hasReadableText: calls === 1 ? false : true,
        regions: [],
        confidence: 0.85,
        note: '可能是截图，但没有可靠定位。',
      }) } }],
    }), { status: 200 });
  };
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'ambiguous-no-text', src: 'https://example.com/ambiguous.png', width: 640, height: 360, status: 'ready' },
    );
    assert.equal(result.noText, false);
    assert.equal(result.regions.length, 0);
    assert.match(result.note, /未自动覆盖|未识别/u);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dense or overlong image regions fall back beside the original image', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      regions: [{
        text: 'A very long explanatory label that does not fit',
        translation: '这是一个很长的解释标签，无法放入原位区域',
        x: 10, y: 10, width: 120, height: 24,
      }],
      confidence: 0.98,
      note: '',
    }) } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'dense-image', src: 'https://example.com/dense.png', width: 640, height: 360, status: 'ready' },
    );
    assert.equal(result.regions.length, 0);
    assert.match(result.fallbackText, /无法安全原位覆盖/u);
    assert.match(result.note, /旁侧译文/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chart axis and legend labels stay at their source positions when they fit', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      regions: [
        { text: 'Completion Time (ms)', translation: '完成时间（毫秒）', x: 18, y: 80, width: 22, height: 180 },
        { text: 'Competing Clients', translation: '竞争客户端数', x: 140, y: 320, width: 150, height: 22 },
        { text: 'Backoff Algorithm', translation: '退避算法', x: 410, y: 120, width: 120, height: 22 },
      ],
      confidence: 0.98,
      fallbackTranslation: '',
      note: '',
    }) } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Chart' },
      { id: 'chart-labels', src: 'https://example.com/chart-labels.png', width: 640, height: 400, status: 'ready' },
    );
    assert.equal(result.regions.length, 3);
    assert.equal(result.fallbackRegions.length, 0);
    assert.equal(result.fallbackText, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('oversized OCR boxes fall back instead of covering surrounding diagram content', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      regions: [{ text: 'Application heading', translation: '应用标题组件', x: 20, y: 20, width: 420, height: 160 }],
      confidence: 0.99,
      note: '',
    }) } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'oversized-box', src: 'https://example.com/diagram.png', width: 800, height: 500, status: 'ready' },
    );
    assert.equal(result.regions.length, 0);
    assert.match(result.fallbackText, /应用标题组件/u);
    assert.match(result.note, /旁侧译文/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dense multi-region images use one side translation instead of many uncertain overlays', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      regions: Array.from({ length: 5 }, (_, index) => ({
        text: `Label${index}`,
        translation: `标签${index}`,
        x: 10 + index * 20,
        y: 10 + index * 8,
        width: 50,
        height: 24,
      })),
      confidence: 0.98,
      fallbackTranslation: '',
      note: '',
    }) } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'dense-multi-region', src: 'https://example.com/dense-many.png', width: 640, height: 360, status: 'ready' },
    );
    assert.equal(result.regions.length, 0);
    assert.match(result.fallbackText, /标签0/u);
    assert.match(result.note, /区域较多|旁侧译文/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('separated high-confidence image regions can remain inline', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      regions: [
        { text: 'Producer', translation: '生产者', x: 12, y: 18, width: 72, height: 18 },
        { text: 'Consumer', translation: '消费者', x: 360, y: 240, width: 78, height: 18 },
      ],
      confidence: 0.98,
      fallbackTranslation: '',
      note: '',
    }) } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Diagram' },
      { id: 'separated-regions', src: 'https://example.com/separated-regions.png', width: 640, height: 360, status: 'ready' },
    );
    assert.equal(result.regions.length, 2);
    assert.equal(result.fallbackText, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('numeric image labels remain in the original image', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      regions: [{ text: '2500', translation: '250', x: 10, y: 10, width: 40, height: 18 }],
      confidence: 0.98,
      note: '',
    }) } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Chart' },
      { id: 'numeric-image', src: 'https://example.com/chart.png', width: 640, height: 360, status: 'ready' },
    );
    assert.equal(result.regions.length, 0);
    assert.equal(result.fallbackText, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ambiguous image OCR gets one bounded second visual attempt', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const content = calls === 1
      ? JSON.stringify({ hasReadableText: true, regions: [], confidence: 0.9, note: '暂未定位' })
      : JSON.stringify({ hasReadableText: true, regions: [{ text: 'Dark label', translation: '深色标签', x: 1, y: 2, width: 30, height: 12 }], confidence: 0.9, note: '' });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'ambiguous-image', src: 'https://example.com/ambiguous-image.png', width: 100, height: 80, status: 'ready' },
    );
    assert.equal(calls, 2);
    assert.equal(result.visionAttempts, 2);
    assert.equal(result.regions.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('image OCR rejects regions that extend outside the source image', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      regions: [{ text: 'edge', translation: '越界', x: 90, y: 2, width: 30, height: 10 }],
      confidence: 0.99,
      fallbackTranslation: '',
      note: '',
    }) } }],
  }), { status: 200 });
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret', language: 'zh-CN' },
      { title: 'Test' },
      { id: 'bounds', src: 'https://example.com/bounds.png', width: 100, height: 80, status: 'ready' },
    );
    assert.equal(result.regions.length, 0);
    assert.match(result.note, /未识别到|可靠定位/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('temporary task input stays bounded and exposes inline image overflow', () => {
  const oversized = `data:image/svg+xml;base64,${'A'.repeat(8_100_000)}`;
  const bounded = boundTaskContext({
    url: 'https://example.com/long',
    body: 'x'.repeat(260_000),
    blocks: [{ id: 'long', kind: 'text', text: 'x'.repeat(14_000) }],
    images: [{ id: 'inline-only', dataUrl: oversized, width: 320, height: 120, status: 'ready' }],
  });
  assert.equal(bounded.body.length, 256_000);
  assert.equal(bounded.blocks[0].text.length, 12_000);
  assert.equal(bounded.images[0].dataUrl, null);
  assert.match(bounded.images[0].inputWarning, /没有可回退的 URL/u);
  assert.ok(bounded.taskWarnings.length >= 2);
});

test('image explanations send visual input and warn when page evidence is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      answer: '图中展示了一个请求进入队列后由消费者处理的流程。',
      evidence: [{ quote: '这句不在正文里', claim: '不应伪造证据。' }],
      background: '队列用于平滑生产者和消费者的速度差。',
      inference: '图中可能通过队列吸收突发流量。',
      limitations: ['仅凭图示无法确认队列容量。'],
    }) } }] }), { status: 200 });
  };
  try {
    const result = await explainImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret' },
      { title: 'Queues', body: 'The queue smooths bursts.' },
      { id: 'image-1', src: 'https://example.com/diagram.png', alt: '队列架构图', width: 640, height: 360 },
      '这张图的瓶颈在哪里？',
    );
    const content = request.messages[1].content;
    assert.equal(content.some((part) => part.type === 'image_url' && part.image_url.url === 'https://example.com/diagram.png'), true);
    assert.match(content.find((part) => part.type === 'text').text, /这张图的瓶颈在哪里/u);
    assert.equal(result.evidence.length, 0);
    assert.ok(result.warnings.some((warning) => /没有可核对的原文证据/u.test(warning)));
    assert.ok(result.warnings.some((warning) => /视觉输入/u.test(warning)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('image explanations support streaming structured answers', async () => {
  const originalFetch = globalThis.fetch;
  const deltas = [];
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    const raw = JSON.stringify({ answer: '图中有两个服务。', evidence: [], limitations: [] });
    return new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: raw.slice(0, 14) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: raw.slice(14) } }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const result = await explainImage(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', visionModel: 'vision-model', apiKey: 'secret' },
      { title: 'Services', body: 'A service receives requests.' },
      { id: 'image-stream', dataUrl: 'data:image/png;base64,AA==', alt: '服务图', width: 120, height: 80 },
      '',
      [],
      { onDelta: (text) => deltas.push(text) },
    );
    assert.equal(result.answer, '图中有两个服务。');
    assert.equal(deltas.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reading answers keep only exact source evidence and expose anchors', () => {
  const body = 'Bounded queues keep browser work responsive. Cancellation stops stale requests.';
  const result = parseReadingAnswer(JSON.stringify({
    answer: '队列限制工作量，取消可以释放过期请求。',
    evidence: [
      { quote: 'Bounded queues keep browser work responsive.', claim: '原文说明队列的作用。' },
      { quote: 'This sentence is not in the page.', claim: '不应进入证据。' },
    ],
    background: '需要理解取消语义。',
    inference: '这有助于控制模型成本。',
    limitations: ['未说明队列大小。'],
  }), {
    url: 'https://example.com/docs',
    body,
    selection: { quote: 'Bounded queues keep browser work responsive.', contentHash: 'a'.repeat(64) },
  });
  assert.equal(result.answer, '队列限制工作量，取消可以释放过期请求。');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.citations[0].anchor.startOffset, 0);
  assert.match(result.warnings[0], /无法在当前原文中/u);
});

test('ordinary prose still gets a selected-source citation', () => {
  const result = parseReadingAnswer('这是普通文本回答。', {
    url: 'https://example.com/docs',
    body: 'The selected source passage.',
    selection: { quote: 'The selected source passage.', contentHash: 'b'.repeat(64) },
  });
  assert.equal(result.structured, false);
  assert.equal(result.evidence[0].quote, 'The selected source passage.');
  assert.equal(result.citations.length, 1);
});

test('malformed structured output keeps the readable answer instead of exposing the JSON envelope', () => {
  const raw = String.raw`{"answer":"这段话说明 AI 写代码速度提高，但周边流程没有同步变化。","evidence":[{"quote":"The selected source passage.","claim":"原文说明流程没有同步变化。"}],"background":"背景中包含一个未转义的 ' 字符，导致整体 JSON 无法解析。}`;
  const result = parseReadingAnswer(raw, {
    url: 'https://example.com/docs',
    body: 'The selected source passage.',
    selection: { quote: 'The selected source passage.', contentHash: 'c'.repeat(64) },
  });
  assert.equal(result.answer, '这段话说明 AI 写代码速度提高，但周边流程没有同步变化。');
  assert.equal(result.structured, true);
  assert.equal(result.evidence[0].quote, 'The selected source passage.');
  assert.match(result.warnings[0], /结构化结果不完整/u);
  assert.doesNotMatch(result.answer, /"evidence"/u);
});

test('escaped or brace-less structured output recovers the answer and evidence', () => {
  const raw = String.raw`answer\":\"否。人工审批仍然保留在关键 gate。\",\"evidence\":[{\"quote\":\"The selected source passage.\",\"claim\":\"原文支持人工判断仍存在。\"}]}`;
  const result = parseReadingAnswer(raw, {
    url: 'https://example.com/docs',
    body: 'The selected source passage.',
    selection: { quote: 'The selected source passage.', contentHash: 'd'.repeat(64) },
  });
  assert.equal(result.answer, '否。人工审批仍然保留在关键 gate。');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.warnings.length, 0);
  assert.doesNotMatch(result.answer, /evidence/u);
});

test('incomplete structured output never exposes JSON syntax as the answer', () => {
  const result = parseReadingAnswer('{"answer":"文章的核心结论是把 SDLC 改造成闭环', {
    url: 'https://example.com/docs',
    body: 'The selected source passage.',
  });
  assert.equal(result.answer, '文章的核心结论是把 SDLC 改造成闭环');
  assert.doesNotMatch(result.answer, /"answer"|evidence/u);
  assert.match(result.warnings[0], /结构化结果不完整/u);
});

test('incomplete structured output retries once before returning the answer', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const content = calls === 1
      ? '{"answer":"第一次输出被截断'
      : JSON.stringify({ answer: '第二次返回完整回答。', evidence: [], limitations: [] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  try {
    const result = await explainSelection(
      { baseUrl: 'https://example.com/v1', model: 'reader-model', apiKey: 'secret' },
      { title: 'Docs', url: 'https://example.com/docs', body: 'The source passage.' },
      '请总结这段。',
      [],
      { maxTokens: 5000 },
    );
    assert.equal(calls, 2);
    assert.equal(result.answer, '第二次返回完整回答。');
    assert.match(result.warnings[0], /自动重试一次/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('local data can be cleared without relying on IndexedDB', async () => {
  await readerStore.setSetting('test', 'value');
  await readerStore.setSetting('provider', { baseUrl: 'https://example.com/v1', model: 'm', visionModel: 'v', language: 'zh-CN', apiKey: 'secret' });
  await readerStore.saveInsight({ title: 'T', url: 'https://example.com', quote: 'Q', apiKey: 'must-never-leak', nested: { token: 'also-secret' } });
  await readerStore.saveAnnotation({
    id: 'annotation-1',
    document: { url: 'https://example.com/docs', title: 'Docs', version: 'version-a' },
    anchor: { quote: 'Old evidence', contentHash: 'a'.repeat(64) },
    note: 'Check this later.',
    apiKey: 'must-never-leak',
  });
  await readerStore.saveJob({ id: 'job-1', documentUrl: 'https://example.com', kind: 'text', status: 'queued' });
  await readerStore.saveTaskInput('job-1', { url: 'https://example.com', body: 'temporary page input' });
  await readerStore.saveSession({ url: 'https://example.com/docs', title: 'Docs', version: 'version-a', answer: 'old evidence' });
  await readerStore.saveSession({ url: 'https://example.com/docs', title: 'Docs', version: 'version-b', answer: 'new evidence' });
  assert.equal(await readerStore.getSetting('test'), 'value');
  assert.equal((await readerStore.listInsights()).length, 1);
  assert.equal((await readerStore.listAnnotations()).length, 1);
  assert.equal((await readerStore.listJobs()).length, 1);
  assert.equal((await readerStore.getTaskInput('job-1')).body, 'temporary page input');
  assert.equal((await readerStore.getSession('https://example.com/docs', 'version-a')).answer, 'old evidence');
  assert.equal((await readerStore.getSession('https://example.com/docs', 'version-b')).answer, 'new evidence');
  assert.equal((await readerStore.getSession('https://example.com/docs')).answer, 'new evidence');
  const exported = await readerStore.exportData();
  assert.equal(Object.hasOwn(exported.settings.find((item) => item.id === 'provider').value, 'apiKey'), false);
  assert.equal(Object.hasOwn(exported, 'taskInputs'), false);
  assert.equal(JSON.stringify(exported).includes('must-never-leak'), false);
  assert.equal(JSON.stringify(exported).includes('also-secret'), false);
  assert.equal(exported.annotations[0].note, 'Check this later.');
  assert.equal(Object.hasOwn(exported.annotations[0], 'apiKey'), false);
  await readerStore.clearAll();
  assert.equal(await readerStore.getSetting('test'), null);
  assert.equal((await readerStore.listInsights()).length, 0);
  assert.equal((await readerStore.listAnnotations()).length, 0);
  assert.equal((await readerStore.listJobs()).length, 0);
  assert.equal(await readerStore.getTaskInput('job-1'), null);
  assert.equal(await readerStore.getSession('https://example.com/docs', 'version-a'), null);
});

test('session sync keys are stable per page version and differ across versions', async () => {
  await readerStore.clearAll();
  const first = await readerStore.getSessionSyncKey('https://example.com/docs', 'v1');
  const repeat = await readerStore.getSessionSyncKey('https://example.com/docs', 'v1');
  const changed = await readerStore.getSessionSyncKey('https://example.com/docs', 'v2');
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.equal(repeat, first);
  assert.notEqual(changed, first);
  await readerStore.clearAll();
});

test('page-version changes mark older sessions stale without changing their evidence', async () => {
  await readerStore.clearAll();
  await readerStore.saveSession({ url: 'https://example.com/docs', title: '旧讨论', version: 'v1', answer: 'old evidence', discussion: [{ role: 'user', content: '旧问题' }] });
  await readerStore.saveSession({ url: 'https://example.com/docs', title: '当前讨论', version: 'v2', answer: 'new evidence', discussion: [{ role: 'user', content: '新问题' }] });
  await readerStore.markSessionsStale('https://example.com/docs', 'v2');
  const oldSession = await readerStore.getSession('https://example.com/docs', 'v1');
  const currentSession = await readerStore.getSession('https://example.com/docs', 'v2');
  assert.equal(oldSession.stale, true);
  assert.equal(oldSession.answer, 'old evidence');
  assert.equal(currentSession.stale, undefined);
  await readerStore.clearAll();
});

test('animated images fail explicitly instead of being translated as a random frame', async () => {
  await assert.rejects(
    () => translateImage({ baseUrl: 'https://example.com/v1', model: 'text', visionModel: 'vision', apiKey: 'key', visionReady: true, language: 'zh-CN' }, { title: 'T' }, { id: 'gif-1', status: 'animated', src: 'https://example.com/diagram.gif', width: 400, height: 200 }),
    /动画图片只处理明确标记的静态帧/u,
  );
});

test('SVG text remains readable beside the original when rasterization is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  await readerStore.clearCache();
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const system = body.messages.find((item) => item.role === 'system')?.content || '';
    assert.match(system, /SVG 图中提取出的文字/u);
    return new Response(JSON.stringify({ choices: [{ message: { content: '生产者\n有界队列' } }] }), { status: 200 });
  };
  try {
    const result = await translateImage(
      { baseUrl: 'https://example.com/v1', model: 'text', visionModel: 'vision', apiKey: 'key', visionReady: true, language: 'zh-CN' },
      { title: 'SVG diagram' },
      { id: 'svg-1', isSvg: true, svgText: 'Producer\nBounded Queue', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', width: 720, height: 180, modelWidth: 720, modelHeight: 180, status: 'ready' },
    );
    assert.equal(result.regions.length, 0);
    assert.match(result.fallbackText, /生产者/u);
    assert.match(result.note, /旁侧译文/u);
  } finally {
    globalThis.fetch = originalFetch;
    await readerStore.clearCache();
  }
});

test('local import preserves the existing API key and rejects malformed collections', async () => {
  await readerStore.clearAll();
  await readerStore.setSetting('provider', {
    baseUrl: 'https://example.com/v1',
    model: 'reader-model',
    visionModel: 'reader-vision',
    language: 'zh-CN',
    apiKey: 'local-secret',
  });
  await readerStore.importData({
    version: 2,
    settings: [{
      id: 'provider',
      value: {
        baseUrl: 'https://imported.example/v1',
        model: 'imported-model',
        apiKey: 'attacker-controlled-key',
      },
    }],
    sessions: [
      { url: 'https://example.com/docs', title: 'Imported docs', version: 'v1', answer: 'saved answer' },
      { url: 'javascript:alert(1)', title: 'must be ignored', version: 'bad' },
    ],
    insights: [
      { url: 'https://example.com/docs', title: 'Imported insight', quote: 'Exact source quote', tags: ['one', 2, 'two'] },
      { url: 'https://example.com/docs', title: 'missing quote' },
    ],
    annotations: [
      {
        id: 'imported-annotation',
        document: { url: 'https://example.com/docs', title: 'Imported docs', version: 'v1' },
        anchor: { quote: 'Exact source quote', prefix: '', suffix: '' },
        note: 'Imported note',
      },
      {
        id: 'invalid-annotation',
        document: { url: 'javascript:alert(1)', title: 'bad' },
        anchor: { quote: 'must be ignored' },
      },
    ],
    taskInputs: [{ id: 'should-not-import', context: { body: 'temporary' } }],
  });
  const provider = await readerStore.getSetting('provider');
  assert.equal(provider.apiKey, 'local-secret');
  assert.equal(provider.model, 'imported-model');
  assert.equal((await readerStore.getSession('https://example.com/docs', 'v1')).answer, 'saved answer');
  assert.equal((await readerStore.listInsights()).length, 1);
  assert.equal((await readerStore.listAnnotations()).length, 1);
  assert.equal((await readerStore.listAnnotations())[0].note, 'Imported note');
  assert.deepEqual((await readerStore.listInsights())[0].tags, ['one', 'two']);
  assert.equal(await readerStore.getTaskInput('should-not-import'), null);
  await assert.rejects(() => readerStore.importData({ version: 2, sessions: {} }), /会话导入格式无效/u);
  await readerStore.clearAll();
});

test('incremental translation keeps old failures until an item resolves', () => {
  const failures = mergeTranslationFailures(
    [{ id: 'block-1', kind: 'text', error: '第一次失败' }, { id: 'image-1', kind: 'image', error: '图片失败' }],
    [{ id: 'block-2', kind: 'text', error: '动态段落失败' }],
    ['block-1'],
  );
  assert.deepEqual(failures.map((item) => item.id), ['image-1', 'block-2']);
  assert.deepEqual(mergeProcessedIds(['block-1'], ['block-1', 'block-3']), ['block-1', 'block-3']);
});
