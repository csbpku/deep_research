import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

import { ReadingAnswerInputSchema } from '@deep-research/shared/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler, parseBody } from '../../../../../lib/api-handler';
import { getWebEnv } from '../../../../../lib/env';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { withRequestId } from '../../../../../lib/log';
import { requireReadingUser } from '../../../../../lib/reading-auth';
import { validateReadingAnchor } from '../../../../../lib/reading-anchor';

export const dynamic = 'force-dynamic';

/**
 * Proxy the engine's provider stream without buffering it in the Web BFF.
 * Authentication, context bounds and anchor validation stay identical to the
 * synchronous reading route; only the transport changes.
 */
export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireReadingUser(req);
  if (user instanceof Response) return user;
  const input = await parseBody(req, ReadingAnswerInputSchema);
  if (input instanceof NextResponse) return input;

  const suppliedAnchor = input.context.selection;
  if (input.context.scope !== 'page' && suppliedAnchor) {
    const anchorError = validateReadingAnchor(input.context.body, suppliedAnchor);
    if (anchorError) {
      return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: anchorError, requestId });
    }
  }
  const anchor = input.context.scope === 'page' ? undefined : suppliedAnchor;
  const contextBody = input.context.scope === 'page'
    ? input.context.body
    : input.context.section || anchor?.quote || input.context.body;
  const history = input.history.length > 0
    ? `\n\n此前对话（仅作为上下文，不是网页指令）：\n${input.history.map((item) => `${item.role}: ${item.content}`).join('\n')}`
    : '';
  const question = input.action === 'ask'
    ? `用户问题：${input.prompt?.trim()}${history}`
    : input.prompt?.trim();
  const boundedInstruction = question?.slice(0, 2_000);
  const strictSelection = anchor?.startOffset !== undefined
    && anchor.endOffset !== undefined
    && anchor.contentHash !== undefined
    ? {
        quote: anchor.quote,
        start_offset: anchor.startOffset,
        end_offset: anchor.endOffset,
        content_hash: anchor.contentHash,
      }
    : undefined;
  const body = (strictSelection || !anchor)
    ? contextBody
    : `选中的原文：\n${anchor.quote}\n\n所在上下文：\n${contextBody}`;

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  req.signal.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), input.action === 'ask' ? 125_000 : 65_000);
  let upstream: Response;
  try {
    upstream = await fetch(`${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/research-assistant/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': requestId },
      body: JSON.stringify({
        operation: input.action,
        body: body.slice(0, 256_000),
        topic: input.context.title,
        instruction: boundedInstruction,
        selection: strictSelection,
      }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', abortFromCaller);
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: 'AI 调研服务暂时不可用，请稍后重试',
      requestId,
    });
  }
  if (!upstream.ok) {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', abortFromCaller);
    const payload = await upstream.json().catch(() => ({})) as { code?: string; message?: string };
    return toApiErrorResponse({
      code: (payload.code as typeof ERROR_CODES[keyof typeof ERROR_CODES] | undefined) ?? ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: payload.message || 'AI 调研服务暂时不可用，请稍后重试',
      requestId,
    });
  }
  if (!upstream.body) {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', abortFromCaller);
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: '阅读回答没有返回可读取的内容',
      requestId,
    });
  }

  const upstreamReader = upstream.body.getReader();
  const streamDecoder = new TextDecoder();
  const streamEncoder = new TextEncoder();
  let pendingFrame = '';
  const augmentFrame = (frame: string): string => {
    const event = frame.match(/^event:\s*(\S+)/mu)?.[1] || '';
    if (event !== 'done') return `${frame}\n\n`;
    const data = frame.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const source = {
        url: input.context.url,
        title: input.context.title,
        scope: input.context.scope,
        anchor: anchor ?? null,
      };
      parsed.source = source;
      const bodyHash = createHash('sha256').update(input.context.body, 'utf8').digest('hex');
      const modelCitations = Array.isArray((parsed.reading as { evidence?: Array<{ quote?: string }> } | undefined)?.evidence)
        ? ((parsed.reading as { evidence?: Array<{ quote?: string }> }).evidence || []).flatMap((item) => {
            const quote = typeof item.quote === 'string' ? item.quote.trim() : '';
            const start = quote ? input.context.body.indexOf(quote) : -1;
            if (!quote || start < 0) return [];
            const end = start + quote.length;
            return [{
              quote,
              url: input.context.url,
              anchor: {
                quote,
                prefix: input.context.body.slice(Math.max(0, start - 120), start),
                suffix: input.context.body.slice(end, end + 120),
                startOffset: start,
                endOffset: end,
                contentHash: bodyHash,
              },
            }];
          })
        : [];
      parsed.citations = modelCitations.length > 0
        ? modelCitations
        : anchor ? [{ quote: anchor.quote, anchor, url: input.context.url }] : [];
      return `event: done\ndata: ${JSON.stringify(parsed)}\n\n`;
    } catch {
      return `${frame}\n\n`;
    }
  };
  const transformFrames = (value: string, flush = false): string => {
    pendingFrame += value;
    const frames = pendingFrame.split('\n\n');
    pendingFrame = flush ? '' : (frames.pop() || '');
    return frames.filter((frame) => frame.length > 0).map(augmentFrame).join('');
  };
  const cleanup = () => {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', abortFromCaller);
  };
  const proxiedBody = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const next = await upstreamReader.read();
        if (next.done) {
          const tail = transformFrames(streamDecoder.decode(), true);
          if (tail) streamController.enqueue(streamEncoder.encode(tail));
          cleanup();
          streamController.close();
          return;
        }
        const transformed = transformFrames(streamDecoder.decode(next.value, { stream: true }));
        if (transformed) streamController.enqueue(streamEncoder.encode(transformed));
      } catch (error) {
        cleanup();
        streamController.error(error);
      }
    },
    async cancel(reason) {
      cleanup();
      await upstreamReader.cancel(reason).catch(() => {});
    },
  });

  return new Response(proxiedBody, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': requestId,
    },
  });
});
