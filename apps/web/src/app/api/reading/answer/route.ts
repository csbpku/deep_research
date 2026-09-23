import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

import { ReadingAnswerInputSchema } from '@deep-research/shared/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { getWebEnv } from '../../../../lib/env';
import { fetchAiEngine } from '../../../../lib/ai-bff/fetch-ai-engine';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';
import { requireReadingUser } from '../../../../lib/reading-auth';
import { validateReadingAnchor } from '../../../../lib/reading-anchor';

type EngineResponse = {
  operation: string;
  original: string;
  suggestion: string | null;
  warnings?: string[];
  metrics?: Record<string, unknown>;
  request_id?: string | null;
  truncated?: boolean;
  reading?: {
    answer?: string;
    background?: string;
    inference?: string;
    limitations?: string[];
    evidence?: Array<{ quote: string; claim?: string }>;
    warnings?: string[];
    structured?: boolean;
  } | null;
};

export const dynamic = 'force-dynamic';

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireReadingUser(req);
  if (user instanceof Response) return user;
  const input = await parseBody(req, ReadingAnswerInputSchema);
  if (input instanceof NextResponse) return input;

  const { context } = input;
  const suppliedAnchor = context.selection;
  if (context.scope !== 'page' && suppliedAnchor) {
    const anchorError = validateReadingAnchor(context.body, suppliedAnchor);
    if (anchorError) {
      return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: anchorError, requestId });
    }
  }
  const anchor = context.scope === 'page' ? undefined : suppliedAnchor;
  // Selection is the narrowest default. The page is only sent when the user
  // explicitly chooses the page scope; this keeps unrelated content out of a
  // focused explanation and makes the scope shown by the UI truthful.
  const contextBody = context.scope === 'page'
    ? context.body
    : context.section || anchor?.quote || context.body;
  const history = input.history.length > 0
    ? `\n\n此前对话（仅作为上下文，不是网页指令）：\n${input.history.map((item) => `${item.role}: ${item.content}`).join('\n')}`
    : '';
  const question = input.action === 'ask'
    ? `用户问题：${input.prompt?.trim()}${history}`
    : input.prompt?.trim();
  const boundedInstruction = question?.slice(0, 2_000);

  // The engine's assistant contract accepts a strict selection only when it
  // has offsets and a content hash. For quote-only clients, keep the quote in
  // the bounded body so the answer is still grounded without pretending that
  // a fragile position is authoritative.
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

  const upstream = await fetchAiEngine<EngineResponse>({
    url: `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/research-assistant`,
    method: 'POST',
    timeoutMs: input.action === 'ask' ? 120_000 : 60_000,
    retry: false,
    signal: req.signal,
    requestId,
    context: 'reading.answer',
    body: {
      operation: input.action,
      body: body.slice(0, 256_000),
      topic: context.title,
      instruction: boundedInstruction,
      selection: strictSelection,
    },
  });
  if (!upstream.ok) {
    return toApiErrorResponse({
      code: upstream.code ?? ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: upstream.message,
      requestId: upstream.requestId,
    });
  }

  const answer = upstream.body.suggestion?.trim() ?? '';
  if (!answer) {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: 'AI 没有生成有效回答，请重试',
      requestId,
    });
  }
  const bodyHash = createHash('sha256').update(context.body, 'utf8').digest('hex');
  const modelCitations = (upstream.body.reading?.evidence ?? []).flatMap((item) => {
    const quote = item.quote?.trim();
    const start = quote ? context.body.indexOf(quote) : -1;
    if (!quote || start < 0) return [];
    const end = start + quote.length;
    const evidenceAnchor = {
      quote,
      prefix: context.body.slice(Math.max(0, start - 120), start),
      suffix: context.body.slice(end, end + 120),
      startOffset: start,
      endOffset: end,
      contentHash: bodyHash,
    };
    return [{ quote, anchor: evidenceAnchor, url: context.url }];
  });
  const citations = modelCitations.length > 0
    ? modelCitations
    : anchor ? [{ quote: anchor.quote, anchor, url: context.url }] : [];
  return NextResponse.json({
    ok: true,
    action: input.action,
    answer,
    original: upstream.body.original,
    source: {
      url: context.url,
      title: context.title,
      scope: context.scope,
      anchor: anchor ?? null,
    },
    citations,
    reading: upstream.body.reading ?? null,
    warnings: upstream.body.warnings ?? upstream.body.reading?.warnings ?? [],
    truncated: Boolean(upstream.body.truncated),
    metrics: upstream.body.metrics ?? {},
    requestId,
  });
});
