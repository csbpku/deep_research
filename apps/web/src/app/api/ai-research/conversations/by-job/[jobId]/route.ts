// BFF: 按调研任务读取唯一对话（任务页恢复历史 + follow-up 追问用）。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler } from '../../../../../../lib/api-handler';
import { requireUser } from '../../../../../../lib/auth/session';
import { prisma } from '../../../../../../lib/db';
import { toApiErrorResponse } from '../../../../../../lib/errors';
import { withRequestId } from '../../../../../../lib/log';
import { publicAiResearchMessage } from '../../../../../../lib/ai-research-chat';

const JobIdParam = z.object({ jobId: z.string().uuid() });

export const GET = apiHandler<[NextRequest, { params: Promise<{ jobId: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const parsed = JobIdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: 'VALIDATION_FAILED' as const,
      message: 'jobId 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const conversation = await prisma.aiResearchConversation.findUnique({
    where: { jobId: parsed.data.jobId },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      _count: { select: { messages: true } },
    },
  });
  if (!conversation || conversation.userId !== user.id) {
    return toApiErrorResponse({
      code: 'AI_JOB_NOT_FOUND' as const,
      message: '会话不存在',
      requestId,
    });
  }

  return NextResponse.json({
    id: conversation.id,
    jobId: conversation.jobId,
    title: conversation.title,
    status: conversation.status,
    messageCount: conversation._count.messages,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    messages: conversation.messages.map(publicAiResearchMessage),
  });
});
