import { parseReadingAnswer, readingAnswerText, responseLanguageInstruction, readingHistoryText } from './reader-core.js';
export async function requestPlatformAnswer(sourceContext, question, scope, options = {}) {
  const { readerToken } = await chrome.storage.local.get(['readerToken']);
  if (!readerToken) throw new Error('平台连接已失效，请重新连接');
  const action = ['explain', 'translate'].includes(options.action) ? options.action : 'ask';
  const response = await fetch(`${options.platformUrl}/api/reading/answer/stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${readerToken}`,
    },
    body: JSON.stringify({
      action,
      webContext: options.webContext,
      context: { url: sourceContext.url, title: sourceContext.title.slice(0, 300), body: sourceContext.body, language: options.language || 'zh-CN', scope, ...(sourceContext.section ? { section: sourceContext.section } : {}), ...(scope === 'selection' && sourceContext.selection ? { selection: sourceContext.selection } : {}) },
      ...(question ? { prompt: `${responseLanguageInstruction(options.replyLanguage || 'auto')}\n\nUser question:\n${question}` } : {}),
      history: (options.history || []).slice(-20).map((item) => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: readingHistoryText(item),
      })),
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(platformAnswerErrorMessage(payload, response.status));
  }
  if (!response.body) throw new Error('平台 AI 没有返回可读取的内容');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamed = '';
  let completed = null;
  const consume = (frame) => {
    const event = frame.match(/^event:\s*(\S+)/mu)?.[1] || '';
    const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data) return;
    const payload = JSON.parse(data);
    if (event === 'delta' && typeof payload.text === 'string') {
      streamed += payload.text;
      options.onDelta?.(payload.text);
    } else if (event === 'error') {
      throw new Error(platformAnswerErrorMessage(payload));
    } else if (event === 'progress') {
      options.onProgress?.(Number(payload.done) || 0, Number(payload.total) || 0, payload.phase || 'analyzing');
    } else if (event === 'done') {
      if (payload.truncated || ['length', 'max_tokens'].includes(payload.finishReason)) {
        throw new Error('平台回答被截断，本次未保存为完整结论。请缩短问题或稍后重试。');
      }
      const reading = payload.reading || {
        answer: payload.answer || payload.suggestion || streamed,
        evidence: [],
        background: '',
        inference: '',
        limitations: [],
        warnings: payload.warnings || [],
      };
      // The platform may fall back to Markdown for malformed model JSON.
      // Display its answer field while retaining the server-checked evidence.
      reading.answer = readingAnswerText(reading.answer);
      if (!reading.evidence?.length && reading.answer) {
        const recovered = parseReadingAnswer(reading.answer, sourceContext);
        if (recovered.evidence.length) {
          reading.evidence = recovered.evidence;
          reading.warnings = (reading.warnings || []).filter((warning) => !/没有找到可核对的原文引文|本轮没有可核对的原文证据/u.test(warning));
        }
      }
      const citations = Array.isArray(payload.citations) ? payload.citations : [];
      const evidence = Array.isArray(reading.evidence) ? reading.evidence : [];
      completed = {
        ...reading,
        evidence: evidence.map((item) => {
          const citation = citations.find((candidate) => candidate?.quote === item?.quote);
          return citation ? { ...item, anchor: citation.anchor || item.anchor, url: citation.url } : item;
        }),
      };
    }
  };
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    frames.forEach(consume);
    if (chunk.done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!completed) throw new Error('平台回答连接提前结束，本次未保存为完整结论。请重试。');
  return completed;
}

export function platformAnswerErrorMessage(payload = {}, status = 0) {
  const detail = [payload.code, payload.message, payload.error?.message]
    .filter((value) => typeof value === 'string')
    .join(' ');
  const requestId = typeof payload.request_id === 'string' ? payload.request_id : typeof payload.requestId === 'string' ? payload.requestId : '';
  let message = '平台 AI 暂时无法完成此请求，请稍后重试；如持续发生，请联系平台管理员。';
  if (/AI_RESPONSE_TRUNCATED|truncated_response|finish_reason=length|输出达到长度上限|输出不完整/iu.test(detail)) {
    message = '回答达到模型输出上限，本次未保存不完整结果。请重新生成，或缩小问题范围后重试。';
  } else if (status === 402 || /insufficient[_ ]balance|insufficient[_ ]quota|credit balance|AI_QUOTA_EXCEEDED/iu.test(detail)) {
    message = '平台模型额度不足，本次请求未完成。请联系平台管理员检查模型服务额度后重试。';
  } else if (status === 429 || /rate[_ ]limit|too many requests/iu.test(detail)) {
    message = '平台模型请求过于频繁，请稍后重试。';
  } else if (/invalid[_ ]api[_ ]key|authenticationerror|invalid api key/iu.test(detail)) {
    message = '平台模型服务鉴权失败。请联系平台管理员检查 AI Engine 配置。';
  } else if (/timed? ?out|timeout|deadline exceeded/iu.test(detail)) {
    message = '平台 AI 处理超时，请缩短问题范围后重试。';
  }
  return requestId ? `${message}（请求编号：${requestId}）` : message;
}


// end

// Image bytes are supplied by the browser; the platform never fetches image URLs.
export async function requestPlatformImageAnswer(context, image, question, options = {}) {
  const { readerToken } = await chrome.storage.local.get(['readerToken']);
  if (!readerToken) throw new Error('平台连接已失效，请重新连接');
  const response = await fetch(`${options.platformUrl}/api/reading/answer-image`, {
    method: 'POST', signal: options.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${readerToken}` },
    body: JSON.stringify({ webContext: options.webContext, imageDataUrl: image.dataUrl, alt: String(image.alt || '').slice(0, 500),
      title: String(context.title || '').slice(0, 300), body: String(context.body || '').slice(0, 24000),
      prompt: `${responseLanguageInstruction(options.replyLanguage || 'auto')}\n\nUser question:\n${String(question || 'Explain the selected diagram.').slice(0, 3500)}`, language: options.replyLanguage || 'auto',
      history: (options.history || []).slice(-12).map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: readingHistoryText(item) })) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(platformAnswerErrorMessage(payload, response.status));
  if (payload.truncated) throw new Error(platformAnswerErrorMessage({ code: 'AI_RESPONSE_TRUNCATED', requestId: payload.requestId }));
  const result = parseReadingAnswer(payload.suggestion || '', { ...context, selection: undefined });
  if (!result.answer?.trim()) throw new Error('平台 AI 没有返回可读取的内容');
  result.warnings.push('图示分析基于视觉输入；可定位的网页文字证据可能为空。');
  return result;
}

export async function requestPlatformSearch(question, title, options = {}) {
  const { readerToken } = await chrome.storage.local.get(['readerToken']);
  if (!readerToken) throw new Error('Platform connection expired');
  const response = await fetch(`${options.platformUrl}/api/reading/search`, {
    method: 'POST', signal: AbortSignal.any([options.signal || new AbortController().signal, AbortSignal.timeout(25000)]),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${readerToken}` },
    body: JSON.stringify({ question: question.slice(0, 2000), title: String(title || '').slice(0, 300) }),
  });
  if (!response.ok) throw new Error('Search unavailable');
  return response.json();
}
