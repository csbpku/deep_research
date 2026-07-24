// BFF handler: append one user message and return the engine-generated assistant reply.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler, parseBody } from '../../../../../../lib/api-handler';
import { requireUser } from '../../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../../lib/errors';
import { withRequestId } from '../../../../../../lib/log';
import {
  CHAT_READ_TIMEOUT_MS,
  CHAT_WRITE_TIMEOUT_MS,
  chatEngineUrl,
  chatSessionNotFound,
  chatSessionOwner,
  fetchChatEngine,
  publicChatMessage,
  readUpstreamJson,
} from '../../../../../../lib/chat-bff';
import type { UpstreamChatMessage, UpstreamChatSession } from '../../../../../../lib/chat-bff';

const SessionIdParam = z.object({ id: z.string().uuid() });
const CreateChatMessageInput = z.object({
  content: z.string().trim().min(1).max(4000),
}).strict();

export const POST = apiHandler<[NextRequest, { params: { id: string } }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const parsed = SessionIdParam.safeParse(ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const input = await parseBody(req, CreateChatMessageInput);
  if (input instanceof NextResponse) return input;

  // Ownership is checked before the mutating request; cross-user access is deliberately 404.
  const ownershipResponse = await fetchChatEngine(
    chatEngineUrl(`/api/chat/sessions/${parsed.data.id}`),
    { method: 'GET' },
    requestId,
    CHAT_READ_TIMEOUT_MS,
    'chat.bff.messages.ownership',
  );
  if (ownershipResponse instanceof NextResponse) return ownershipResponse;

  const ownershipBody = await readUpstreamJson(ownershipResponse, requestId);
  if (ownershipBody instanceof NextResponse) return ownershipBody;
  if (chatSessionOwner(ownershipBody as UpstreamChatSession) !== user.id) {
    return chatSessionNotFound(requestId);
  }

  const upstreamResponse = await fetchChatEngine(
    chatEngineUrl(`/api/chat/sessions/${parsed.data.id}/messages`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: user.id,
        role: 'user',
        content: input.content,
      }),
    },
    requestId,
    CHAT_WRITE_TIMEOUT_MS,
    'chat.bff.messages.create',
  );
  if (upstreamResponse instanceof NextResponse) return upstreamResponse;

  const body = await readUpstreamJson(upstreamResponse, requestId);
  if (body instanceof NextResponse) return body;

  return NextResponse.json(publicChatMessage(body as UpstreamChatMessage));
});
