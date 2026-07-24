// BFF handler: create an AI follow-up chat session from a radar summary.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { requireUser } from '../../../../lib/auth/session';
import { withRequestId } from '../../../../lib/log';
import {
  CHAT_WRITE_TIMEOUT_MS,
  chatEngineUrl,
  fetchChatEngine,
  publicChatSession,
  readUpstreamJson,
} from '../../../../lib/chat-bff';
import type { UpstreamChatSession } from '../../../../lib/chat-bff';

const CreateChatSessionInput = z.object({
  seedSummaryId: z.string().uuid(),
}).strict();

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const input = await parseBody(req, CreateChatSessionInput);
  if (input instanceof NextResponse) return input;

  const upstreamResponse = await fetchChatEngine(
    chatEngineUrl('/api/chat/sessions'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: user.id,
        seed_summary_id: input.seedSummaryId,
      }),
    },
    requestId,
    CHAT_WRITE_TIMEOUT_MS,
    'chat.bff.sessions.create',
  );
  if (upstreamResponse instanceof NextResponse) return upstreamResponse;

  const body = await readUpstreamJson(upstreamResponse, requestId);
  if (body instanceof NextResponse) return body;

  return NextResponse.json(publicChatSession(body as UpstreamChatSession));
});
