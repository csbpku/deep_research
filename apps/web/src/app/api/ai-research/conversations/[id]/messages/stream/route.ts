// BFF: 调研完成后的 follow-up 追问（SSE）。
// 流程：校验归属 → 落库 user 消息 → 带上报告正文 + 历史请求 ai-engine →
// 原样透传 SSE → 收到 done 后落库 assistant 消息并追加 persisted 事件。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler, parseBody } from '../../../../../../../lib/api-handler';
import { requireUser } from '../../../../../../../lib/auth/session';
import { prisma } from '../../../../../../../lib/db';
import { toApiErrorResponse } from '../../../../../../../lib/errors';
import { withRequestId } from '../../../../../../../lib/log';
import {
  chatEngineUrl,
  streamChatEngine,
} from '../../../../../../../lib/chat-bff';
import { loadResearchReportForJob } from '../../../../../../../lib/research-chat-bff';

const IdParam = z.object({ id: z.string().uuid() });
const FollowUpInput = z.object({
  content: z.string().trim().min(1, '提问不能为空').max(32000, '提问最多 32000 字'),
  intent: z.enum(['answer', 'verify', 'revise', 'action']).default('answer'),
}).strict();

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

  const input = await parseBody(req, FollowUpInput);
  if (input instanceof NextResponse) return input;

  const conversation = await prisma.aiResearchConversation.findUnique({
    where: { id: parsed.data.id },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!conversation || conversation.userId !== user.id) {
    return toApiErrorResponse({
      code: 'AI_JOB_NOT_FOUND' as const,
      message: '会话不存在',
      requestId,
    });
  }
  const conversationId = conversation.id;
  if (!conversation.jobId) {
    return toApiErrorResponse({
      code: 'AI_JOB_NOT_FOUND' as const,
      message: '调研尚未启动，暂不能追问',
      requestId,
    });
  }

  const report = await loadResearchReportForJob(conversation.jobId, requestId);
  if (!report) {
    return toApiErrorResponse({
      code: 'AI_JOB_NOT_FOUND' as const,
      message: '调研报告不存在',
      requestId,
    });
  }
  const followUpIntent = input.intent;

  await prisma.aiResearchConversationMessage.create({
    data: {
      conversationId,
      role: 'user',
      content: input.content,
      intent: followUpIntent,
    },
  });

  async function persistAssistantMessage(content: string): Promise<string> {
    const created = await prisma.aiResearchConversationMessage.create({
      data: {
        conversationId,
        role: 'assistant',
        content: content.slice(0, 100_000),
        intent: followUpIntent,
      },
    });
    await prisma.aiResearchConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    return created.id;
  }

  const history = conversation.messages
    .slice(-20)
    .map((message) => ({ role: message.role, content: message.content }));

  const upstream = await streamChatEngine(
    chatEngineUrl('/api/ai-research/chat/follow-up'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: user.id,
        report_title: report.title,
        report_content: report.content,
        evidence: report.evidence,
        history,
        question: input.content,
        intent: followUpIntent,
      }),
    },
    requestId,
    'ai.bff.followup.stream',
  );
  if (upstream instanceof NextResponse) return upstream;
  if (!upstream.ok || !upstream.body) {
    const fallbackMessage = 'AI 追问服务暂时不可用，请稍后重试';
    await persistAssistantMessage(`回答失败：${fallbackMessage}`);
    return toApiErrorResponse({
      code: 'AI_ENGINE_UNAVAILABLE' as const,
      message: fallbackMessage,
      requestId,
    });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = '';
  let pendingAssistant = '';
  let pendingError: string | null = null;

  const passthrough = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          controller.enqueue(value);
          sseBuffer += decoder.decode(value, { stream: true });
          const frames = sseBuffer.split('\n\n');
          sseBuffer = frames.pop() ?? '';
          for (const frame of frames) {
            const lines = frame.split('\n');
            const eventLine = lines.find((line) => line.startsWith('event: '));
            const dataLine = lines.find((line) => line.startsWith('data: '));
            if (!dataLine) continue;
            const event = eventLine ? eventLine.slice(7).trim() : 'progress';
            if (event === 'done') {
              try {
                const payload = JSON.parse(dataLine.slice(6)) as { content?: string };
                if (typeof payload.content === 'string' && payload.content) {
                  pendingAssistant = payload.content;
                }
              } catch {
                // A malformed done frame does not block the passthrough.
              }
            } else if (event === 'error') {
              try {
                const payload = JSON.parse(dataLine.slice(6)) as { message?: string };
                if (typeof payload.message === 'string' && payload.message) {
                  pendingError = payload.message;
                }
              } catch {
                // A malformed error frame still leaves the transcript coherent.
              }
            }
          }
        }

        let persistedMessageId: string | null = null;
        if (pendingAssistant) {
          persistedMessageId = await persistAssistantMessage(pendingAssistant);
        } else if (pendingError) {
          persistedMessageId = await persistAssistantMessage(`回答失败：${pendingError}`);
        } else {
          persistedMessageId = await persistAssistantMessage('回答中断，请重试。');
        }
        controller.enqueue(encoder.encode(`event: persisted\ndata: ${JSON.stringify({ ok: true, message_id: persistedMessageId })}\n\n`));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(passthrough, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      'x-request-id': requestId,
    },
  });
});
