// BFF: AI 调研持久化对话 —— 列表 / 创建。
//
// 规划阶段的对话先落库（jobId 为空），提交调研后由 PATCH 补齐 jobId，
// 这样刷新 / 重新打开页面不会丢失已经聊过的内容。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { requireUser } from '../../../../lib/auth/session';
import { prisma } from '../../../../lib/db';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';
import { publicAiResearchMessage } from '../../../../lib/ai-research-chat';

const CreateConversationInput = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(200, '标题最多 200 字'),
  jobId: z.string().uuid().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(32000),
      }),
    )
    .max(200)
    .optional(),
}).strict();

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const conversations = await prisma.aiResearchConversation.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { _count: { select: { messages: true } } },
  });

  return NextResponse.json({
    items: conversations.map((conversation) => ({
      id: conversation.id,
      jobId: conversation.jobId,
      title: conversation.title,
      status: conversation.status,
      messageCount: conversation._count.messages,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    })),
  });
});

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const input = await parseBody(req, CreateConversationInput);
  if (input instanceof NextResponse) return input;

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

  const conversation = await prisma.aiResearchConversation.create({
    data: {
      userId: user.id,
      jobId: input.jobId ?? null,
      title: input.title,
      messages: input.messages?.length
        ? {
            create: input.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          }
        : undefined,
    },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      _count: { select: { messages: true } },
    },
  });

  return NextResponse.json(
    {
      id: conversation.id,
      jobId: conversation.jobId,
      title: conversation.title,
      status: conversation.status,
      messageCount: conversation._count.messages,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      messages: conversation.messages.map(publicAiResearchMessage),
    },
    { status: 201 },
  );
});
