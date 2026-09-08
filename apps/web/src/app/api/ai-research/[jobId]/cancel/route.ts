// BFF: 取消当前用户仍在运行的 AI 调研任务。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { prisma } from '../../../../../lib/db';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { withRequestId } from '../../../../../lib/log';
import { fetchAiEngine } from '../../../../../lib/ai-bff/fetch-ai-engine';
import { getWebEnv } from '../../../../../lib/env';

const Params = z.object({ jobId: z.string().uuid() });

export const POST = apiHandler<[NextRequest, { params: Promise<{ jobId: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: 'VALIDATION_FAILED' as const,
      message: 'jobId 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const job = await prisma.aiResearchJob.findUnique({
    where: { id: parsed.data.jobId },
    select: { requesterId: true },
  });
  if (!job || job.requesterId !== user.id) {
    return toApiErrorResponse({ code: 'AI_JOB_NOT_FOUND' as const, message: '任务不存在', requestId });
  }

  const env = getWebEnv();
  const result = await fetchAiEngine<{ job_id: string; was_queued: boolean; was_running: boolean }>({
    url: `${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/jobs/${parsed.data.jobId}/cancel`,
    method: 'POST',
    expect: 200,
    requestId,
    context: 'ai.bff.cancel',
    retry: false,
  });
  if (!result.ok) {
    return toApiErrorResponse({
      code: result.code,
      message: result.message,
      requestId: result.requestId,
      details: result.details,
    });
  }

  return NextResponse.json({
    jobId: result.body.job_id,
    wasQueued: result.body.was_queued,
    wasRunning: result.body.was_running,
  });
});
