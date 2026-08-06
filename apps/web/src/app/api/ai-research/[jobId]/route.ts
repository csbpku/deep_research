// BFF handler: 查询 AI 调研任务状态（架构 §七 GET /api/ai-research/{id}/status）。
//
// 前端每 5s 轮询本端，本端反代 ai-engine GET /api/ai/jobs/{id}。
// 验收 4：状态轮询 ≤5s 间隔 —— 由前端 useQuery { refetchInterval: 5000 } 负责，
// 本端只做无状态透传。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler } from '../../../../lib/api-handler';
import { prisma } from '../../../../lib/db';
import { requireUser } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { log, withRequestId } from '../../../../lib/log';
import { getWebEnv } from '../../../../lib/env';
import { fetchAiEngine } from '../../../../lib/ai-bff/fetch-ai-engine';

const IdParam = z.object({ jobId: z.string().uuid() });

interface UpstreamJobOut {
  job_id: string;
  status: string;
  topic?: string | null;
  final_status?: string | null;
  current_step?: string | null;
  sources_count?: number;
  partial_sources_count?: number;
  failed_sources_count?: number;
  error_stage?: string | null;
  token_input_total?: number;
  token_output_total?: number;
  cost_cents?: number;
  draft_research_id?: string | null;
  report_type?: string | null;
  output_text?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  error_details?: Record<string, unknown> | null;
  request_id?: string | null;
  started_at?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  review?: Record<string, unknown> | null;
}

export const GET = apiHandler<[NextRequest, { params: Promise<{ jobId: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const parsed = IdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'jobId 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // 归属校验（W9 code review 修订，S0 越权）：
  // 此前本端只做 requireUser（确认已登录）就把 jobId 透传给上游，
  // 而上游 GET /api/ai/jobs/{id} 也只按 job_id 取行，任何登录用户
  // 拿到别人的 jobId 即可读到其 costCents / tokenTotal / errorMessage /
  // draftResearchId。这里在反代前先确认 job 属于当前用户。
  // 非 owner 一律返回 AI_JOB_NOT_FOUND（而非 PERMISSION_DENIED），
  // 避免把「该 job 存在」这一事实泄露出去。
  const job = await prisma.aiResearchJob.findUnique({
    where: { id: parsed.data.jobId },
    select: { requesterId: true },
  });
  if (job === null || job.requesterId !== u.id) {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_JOB_NOT_FOUND,
      message: '任务不存在',
      requestId,
    });
  }

  const env = getWebEnv();
  const url = `${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/jobs/${parsed.data.jobId}`;

  const fetched = await fetchAiEngine<UpstreamJobOut>({
    url,
    requestId,
    context: 'ai.bff.status',
  });
  if (!fetched.ok) {
    return toApiErrorResponse({
      code: fetched.code,
      message: fetched.message,
      requestId: fetched.requestId,
    });
  }
  const up = fetched.body;
  return NextResponse.json({
    jobId: up.job_id,
    status: up.status,
    topic: up.topic ?? null,
    finalStatus: up.final_status ?? null,
    currentStep: up.current_step ?? null,
    sourcesCount: up.sources_count ?? 0,
    partialSourcesCount: up.partial_sources_count ?? 0,
    failedSourcesCount: up.failed_sources_count ?? 0,
    errorStage: up.error_stage ?? null,
    tokenInputTotal: up.token_input_total ?? 0,
    tokenOutputTotal: up.token_output_total ?? 0,
    costCents: up.cost_cents ?? 0,
    draftResearchId: up.draft_research_id ?? null,
    reportType: up.report_type ?? null,
    outputText: up.output_text ?? null,
    errorCode: up.error_code ?? null,
    errorMessage: up.error_message ?? null,
    errorDetails: up.error_details ?? null,
    startedAt: up.started_at ?? null,
    createdAt: up.created_at ?? null,
    completedAt: up.completed_at ?? null,
    review: up.review ?? null,
  });
});
