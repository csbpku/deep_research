// BFF: 向 AI 调研对话批量追加规划阶段消息。
// 规划阶段的 assistant 回复由前端状态机生成，这里只负责持久化。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler, parseBody } from '../../../../../../lib/api-handler';
import { requireUser } from '../../../../../../lib/auth/session';
import { prisma } from '../../../../../../lib/db';
import { toApiErrorResponse } from '../../../../../../lib/errors';
import { withRequestId } from '../../../../../../lib/log';
import { publicAiResearchMessage } from '../../../../../../lib/ai-research-chat';

const IdParam = z.object({ id: z.string().uuid() });
const AppendMessagesInput = z
  .object({
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().min(1).max(32000),
        }),
      )
      .min(1)
      .max(50),
  })
  .strict();

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const parsed = IdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: 'VALIDATION_FAILED' as const,
      message: 'id 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const input = await parseBody(req, AppendMessagesInput);
  if (input instanceof NextResponse) return input;

  const existing = await prisma.aiResearchConversation.findUnique({
    where: { id: parsed.data.id },
    select: { userId: true },
  });
  if (!existing || existing.userId !== user.id) {
    return toApiErrorResponse({
      code: 'AI_JOB_NOT_FOUND' as const,
      message: '会话不存在',
      requestId,
    });
  }

  await prisma.aiResearchConversation.update({
    where: { id: parsed.data.id },
    data: {
      messages: {
        create: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      },
    },
  });

  const conversation = await prisma.aiResearchConversation.findUnique({
    where: { id: parsed.data.id },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      _count: { select: { messages: true } },
    },
  });

  return NextResponse.json({
    id: conversation?.id,
    jobId: conversation?.jobId ?? null,
    title: conversation?.title ?? '',
    status: conversation?.status ?? '',
    messageCount: conversation?._count.messages ?? 0,
    createdAt: conversation?.createdAt.toISOString() ?? '',
    updatedAt: conversation?.updatedAt.toISOString() ?? '',
    messages: (conversation?.messages ?? []).map(publicAiResearchMessage),
  });
});
