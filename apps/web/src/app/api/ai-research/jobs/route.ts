// BFF handler: GET /api/ai-research/jobs — 该用户的 AI 调研任务历史列表。
//
// 契约源：
//   - packages/ai-engine/ai_engine/server/app.py:ListAiJobsResponse
//   - apps/web/prisma/schema.prisma:AiResearchJob
//   - docs/contracts/api-schemas.md §路由前缀：/api/ai/* 由 web 反代 ai-engine
//
// 行为：
//   1. requireUser（未登录 → 401 AUTH_NOT_AUTHENTICATED）
//   2. 透传 status / limit / offset 到 ai-engine（querystring 形式）
//   3. server-side override：requester_id 强制设为 u.id（不能信 client）
//   4. 反代 GET /api/ai/jobs 给 ai-engine（超时 5s）
//   5. 把 ai-engine 的 status_code + body 透回；snake_case → camelCase
//
// 路由冲突：Next.js 中静态段 /api/ai-research/jobs 优先于动态段
// /api/ai-research/[jobId]，所以这里 "jobs" 字面量不会撞 UUID。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler } from '../../../../lib/api-handler';
import { requireUser } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { log, withRequestId, serializeError } from '../../../../lib/log';
import { getWebEnv } from '../../../../lib/env';

const QuerySchema = z.object({
  status: z.string().min(1).max(64).optional(),
  limit: z
    .string()
    .regex(/^[0-9]+$/u)
    .transform((v) => Math.min(100, Math.max(1, parseInt(v, 10))))
    .optional(),
  offset: z
    .string()
    .regex(/^[0-9]+$/u)
    .transform((v) => Math.max(0, parseInt(v, 10)))
    .optional(),
});

const AI_ENGINE_TIMEOUT_MS = 5_000;

interface ListAiJobsItem {
  job_id: string;
  topic: string;
  status: string;
  current_step: string | null;
  report_type: string;
  source_policy: string;
  token_input_total: number;
  token_output_total: number;
  cost_cents: number;
  draft_research_id: string | null;
  published_research_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
}

interface UpstreamResponse {
  items: ListAiJobsItem[];
  total: number;
  limit: number;
  offset: number;
}

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '查询参数错误',
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { status, limit, offset } = parsed.data;

  const upstream = new URL(`${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/jobs`);
  upstream.searchParams.set('requester_id', u.id);
  if (status) upstream.searchParams.set('status', status);
  upstream.searchParams.set('limit', String(limit ?? 20));
  upstream.searchParams.set('offset', String(offset ?? 0));

  let upstreamRes: Response;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), AI_ENGINE_TIMEOUT_MS);
    upstreamRes = await fetch(upstream, {
      headers: { 'x-request-id': requestId },
      signal: ac.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    log.warn('ai.bff.list', 'upstream fetch failed', {
      requestId,
      err: serializeError(err),
      upstream: upstream.toString(),
    });
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: 'ai-engine 不可达',
      requestId,
    });
  }

  const text = await upstreamRes.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: 'ai-engine 返回非 JSON',
      requestId,
    });
  }

  if (!upstreamRes.ok) {
    const obj = body as { detail?: unknown; message?: string };
    const code =
      upstreamRes.status === 422 ? ERROR_CODES.VALIDATION_FAILED : ERROR_CODES.AI_ENGINE_UNAVAILABLE;
    return toApiErrorResponse({
      code,
      message: obj.message ?? `ai-engine 返回 ${upstreamRes.status}`,
      requestId,
      details: obj.detail,
    });
  }

  const up = body as UpstreamResponse;
  return NextResponse.json({
    items: up.items.map((it) => ({
      jobId: it.job_id,
      topic: it.topic,
      status: it.status,
      currentStep: it.current_step,
      reportType: it.report_type,
      sourcePolicy: it.source_policy,
      tokenInputTotal: it.token_input_total,
      tokenOutputTotal: it.token_output_total,
      costCents: it.cost_cents,
      draftResearchId: it.draft_research_id,
      publishedResearchId: it.published_research_id,
      errorCode: it.error_code,
      errorMessage: it.error_message,
      createdAt: it.created_at,
      updatedAt: it.updated_at,
      completedAt: it.completed_at,
    })),
    total: up.total,
    limit: up.limit,
    offset: up.offset,
  });
});
