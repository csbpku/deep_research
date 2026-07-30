// BFF handler: create an AI follow-up chat session from a radar summary.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { prisma } from '../../../../lib/db';
import { requireUser } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
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

  // W9 安全复审修订（S0）：此前任何登录用户可针对任意 summary（含
  // candidate / rejected / archived 态）发起 AI 对话并读取其全文。
  // 错误码 AI_CHAT_FORBIDDEN_SEED 在 errors.py 和 chat-bff.ts 里
  // 已定义但从未被 raise —— 基础设施存在但未连线。
  // 现在在反代前校验：种子必须存在、已发布、且可见于当前用户。
  const seed = await prisma.summary.findUnique({
    where: { id: input.seedSummaryId },
    select: { id: true, status: true },
  });
  if (!seed || seed.status !== 'published') {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_CHAT_FORBIDDEN_SEED,
      message: '该摘要不可用于对话',
      requestId,
    });
  }

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
