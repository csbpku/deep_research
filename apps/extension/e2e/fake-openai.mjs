import { appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const responseDelay = Number(process.env.FAKE_DELAY_MS || 0);
const requestLogPath = process.env.FAKE_REQUEST_LOG || '';
let requestSequence = 0;

/**
 * Deterministic OpenAI-compatible provider for the browser smoke tests.
 * It deliberately distinguishes the three contracts the extension uses:
 * text translation, image OCR/position output, and structured explanation.
 */
const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'POST, OPTIONS',
    });
    response.end();
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const payload = raw ? JSON.parse(raw) : {};
  if (requestLogPath) {
    await appendFile(requestLogPath, `${JSON.stringify({
      sequence: ++requestSequence,
      stream: Boolean(payload.stream),
      model: payload.model || null,
      hasImage: Array.isArray(payload.messages?.at(-1)?.content)
        && payload.messages.at(-1).content.some((part) => part.type === 'image_url'),
      at: new Date().toISOString(),
    })}\n`);
  }
  const system = String(payload.messages?.find((item) => item.role === 'system')?.content || '');
  const user = payload.messages?.at(-1);
  const content = Array.isArray(user?.content)
    ? user.content.map((part) => part.text || '').join('\n')
    : String(user?.content || '');
  const hasImage = Array.isArray(user?.content) && user.content.some((part) => part.type === 'image_url');

  let answer = '这段内容说明了一个可取消、可重试的技术流程。';
  if (system.includes('视觉能力检查器')) {
    answer = 'READER_VISION_CHECK';
  } else if (system.includes('图片里有什么') || (hasImage && !system.includes('图片翻译器') && !system.includes('图示解读助手'))) {
    answer = 'OK';
  } else if (system.includes('图片翻译器')) {
    const raster = content.includes('Raster queue diagram');
    answer = JSON.stringify({
      regions: [raster
        ? { text: 'Raster Queue', translation: '栅格队列', x: 16, y: 34, width: 180, height: 44 }
        : { text: 'Bounded Queue', translation: '有界队列', x: 286, y: 22, width: 190, height: 72 }],
      confidence: 0.95,
      fallbackTranslation: '',
      note: '',
    });
  } else if (system.includes('图示解读助手')) {
    answer = JSON.stringify({
      answer: '图示展示了生产者把工作放入有界队列，再由工作器处理；队列容量控制背压和延迟。',
      evidence: [{ quote: 'Bounded queues keep browser work responsive because cancellation can stop stale requests before they consume more model capacity.', claim: '正文说明有界队列和取消机制的作用。' }],
      background: '背压会把处理速度差异传回生产者。',
      inference: '队列容量需要在吞吐、内存和延迟之间权衡。',
      limitations: ['图示没有提供实际吞吐或容量数据。'],
    });
  } else if (content.includes('页面标题') || content.includes('用户问题')) {
    answer = JSON.stringify({
      answer: content.includes('如果队列容量很小')
        ? '容量过小时，生产者会更频繁地阻塞，吞吐下降但背压更早出现。'
        : '这段内容强调有界队列和取消机制可以避免过期请求继续消耗模型容量。',
      evidence: [{ quote: 'Bounded queues keep browser work responsive because cancellation can stop stale requests before they consume more model capacity.', claim: '原文直接说明队列和取消的作用。' }],
      background: '有界队列会限制同时处理的工作量。',
      inference: '这有助于把阅读任务的延迟和成本控制在可预测范围内。',
      limitations: ['夹具没有给出具体队列容量。'],
    });
  } else if (system.includes('翻译器')) {
    answer = '有界队列可以让浏览器工作保持响应。';
  }

  if (responseDelay > 0) await new Promise((resolve) => setTimeout(resolve, responseDelay));
  response.writeHead(200, {
    'content-type': payload.stream ? 'text/event-stream' : 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-cache',
  });
  const output = { choices: [{ message: { content: answer } }] };
  if (payload.stream) {
    const pieces = [answer.slice(0, Math.ceil(answer.length / 2)), answer.slice(Math.ceil(answer.length / 2))];
    for (const piece of pieces) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  } else {
    response.end(JSON.stringify(output));
  }
});

const port = Number(process.env.PORT || 8799);
server.listen(port, '127.0.0.1', () => console.log(`fake reader model listening on ${port}`));
