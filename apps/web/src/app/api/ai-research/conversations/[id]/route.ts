// BFF: 读取 / 更新单个 AI 调研对话。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler, parseBody } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { prisma } from '../../../../../lib/db';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { withRequestId } from '../../../../../lib/log';
import { publicAiResearchMessage } from '../../../../../lib/ai-research-chat';

const IdParam = z.object({ id: z.string().uuid() });
const UpdateConversationInput = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    jobId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const GET = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
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

  const conversation = await prisma.aiResearchConversation.findUnique({
    where: { id: parsed.data.id },
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

export const PATCH = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
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

  const input = await parseBody(req, UpdateConversationInput);
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

  if (input.jobId) {
    const job = await prisma.aiResearchJob.findUnique({
      where: { id: input.jobId },
      select: { requesterId: true },
    });
    if (!job || job.requesterId !== user.id) {
      return toApiErrorResponse({
        code: 'AI_JOB_NOT_FOUND' as const,
        message: '任务不存在',
        requestId,
      });
    }
  }

  const conversation = await prisma.aiResearchConversation.update({
    where: { id: parsed.data.id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      _count: { select: { messages: true } },
    },
  });

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
