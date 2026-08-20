// BFF SSE passthrough for chat. Streams the upstream ai-engine SSE body
// (start / delta / citations / done / error events) through to the
// browser verbatim. Same ownership + input validation as the polling
// POST; the streaming endpoint is additive — the polling endpoint stays
// in place as a fallback.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler, parseBody } from '../../../../../../../lib/api-handler';
import { requireUser } from '../../../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../../../lib/errors';
import { withRequestId } from '../../../../../../../lib/log';
import {
  CHAT_READ_TIMEOUT_MS,
  chatEngineUrl,
  chatSessionNotFound,
  chatSessionOwner,
  fetchChatEngine,
  readUpstreamJson,
  streamChatEngine,
} from '../../../../../../../lib/chat-bff';
import type { UpstreamChatSession } from '../../../../../../../lib/chat-bff';

const SessionIdParam = z.object({ id: z.string().uuid() });
const StreamMessageInput = z.object({
  content: z.string().trim().min(1, '提问不能为空').max(32000, '提问最多 32000 字'),
  anchor: z
    .object({
      quote: z.string().max(12000),
      startOffset: z.number().int(),
      endOffset: z.number().int(),
      contextScope: z.enum(['selection', 'paragraph', 'section', 'full', 'project']).optional(),
      contextText: z.string().max(256000).optional(),
    })
    .optional(),
}).strict();

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const parsed = SessionIdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
    });
  }

  const input = await parseBody(req, StreamMessageInput);
  if (input instanceof NextResponse) return input;

  // Ownership probe — same as the polling POST.
  const ownershipResponse = await fetchChatEngine(
    chatEngineUrl(`/api/chat/sessions/${parsed.data.id}`),
    { method: 'GET' },
    requestId,
    CHAT_READ_TIMEOUT_MS,
    'chat.bff.messages_stream.ownership',
  );
  if (ownershipResponse instanceof NextResponse) return ownershipResponse;
  const ownershipBody = await readUpstreamJson(ownershipResponse, requestId);
  if (ownershipBody instanceof NextResponse) return ownershipBody;
  if (chatSessionOwner(ownershipBody as UpstreamChatSession) !== user.id) {
    return chatSessionNotFound(requestId);
  }

  const upstream = await streamChatEngine(
    chatEngineUrl(`/api/chat/sessions/${parsed.data.id}/messages/stream`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: user.id,
        role: 'user',
        content: input.content,
        ...(input.anchor ? { anchor: input.anchor } : {}),
      }),
    },
    requestId,
    'chat.bff.messages_stream.proxy',
  );
  if (upstream instanceof NextResponse) return upstream;
  if (!upstream.ok || !upstream.body) {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: 'ai-engine 不可达',
      requestId,
    });
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      'x-request-id': requestId,
    },
  });
});
