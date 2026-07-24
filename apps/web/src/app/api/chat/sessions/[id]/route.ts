// BFF handler: read a chat session and its complete message history.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { withRequestId } from '../../../../../lib/log';
import {
  CHAT_READ_TIMEOUT_MS,
  chatEngineUrl,
  chatSessionNotFound,
  chatSessionOwner,
  fetchChatEngine,
  publicChatSession,
  readUpstreamJson,
} from '../../../../../lib/chat-bff';
import type { UpstreamChatSession } from '../../../../../lib/chat-bff';

const SessionIdParam = z.object({ id: z.string().uuid() });

export const GET = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const parsed = SessionIdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const upstreamResponse = await fetchChatEngine(
    chatEngineUrl(`/api/chat/sessions/${parsed.data.id}`),
    { method: 'GET' },
    requestId,
    CHAT_READ_TIMEOUT_MS,
    'chat.bff.sessions.get',
  );
  if (upstreamResponse instanceof NextResponse) return upstreamResponse;

  const body = await readUpstreamJson(upstreamResponse, requestId);
  if (body instanceof NextResponse) return body;

  const session = body as UpstreamChatSession;
  if (chatSessionOwner(session) !== user.id) return chatSessionNotFound(requestId);

  return NextResponse.json(publicChatSession(session));
});
