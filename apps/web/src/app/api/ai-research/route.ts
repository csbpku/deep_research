// BFF handler: 提交 AI 调研任务（架构 §七 POST /api/ai-research）。
//
// 契约源：
//   - packages/shared/src/schemas.ts CreateAiJobInput
//   - docs/contracts/api-schemas.md §路由前缀：/api/ai/* 由 web 反代 ai-engine
//   - docs/contracts/error-codes.md §"AI 调研" 错误码（透传）
//   - docs/contracts/metrics.md：ai_research_submitted 在提交事务写入（Week 5+ 在
//     ai-engine worker 内写；本端 P0 不重复写，ai-engine 后续会接管）
//
// BFF 行为：
//   1. requireUser（未登录 → 401 AUTH_NOT_AUTHENTICATED；满足验收 6）
//   2. zod 解析 CreateAiJobInput
//   3. server 端补 requester_id（不允许客户端传；当前 ai-engine SubmitAiJobBody 接受
//      requester_id 字段，按 contracts/api-schemas.md Python 镜像约定存在）
//   4. forward 到 AI_ENGINE_URL/api/ai/jobs（Fetch + 超时 + x-request-id 透传）
//   5. 把 ai-engine 的 status_code + body 透回客户端；BFF 不消费业务字段
//
// 不在 BFF 做配额校验 —— 配额由 ai-engine 在 Week 5 落库时检查（架构 §九 风险 4）；
// 本周 ai-engine 同步执行 fake adapter，配额不生效；用户契约由 ai-engine 错误码承担。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { CreateAiJobInput } from '@deep-research/shared/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler, parseBody } from '../../../lib/api-handler.js';
import { requireUser } from '../../../lib/auth/session.js';
import { toApiErrorResponse } from '../../../lib/errors.js';
import { log, withRequestId, serializeError } from '../../../lib/log.js';
import { getWebEnv } from '../../../lib/env.js';

const AI_ENGINE_TIMEOUT_MS = 10_000;

interface SubmitAiJobBodyOut {
  job_id: string;
  status: string;
  final_status?: string | null;
  current_step?: string | null;
  sources_count?: number;
  token_input_total?: number;
  token_output_total?: number;
  cost_cents?: number;
  search_count?: number;
  error_code?: string | null;
  error_message?: string | null;
  request_id?: string | null;
}

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const body = await parseBody(req, CreateAiJobInput);
  if (body instanceof NextResponse) return body;

  // server-side override: requester_id = current user
  // 不接受客户端传入的 requester_id；ai-engine 仍允许接收以便测试，但生产端 web 必须 override
  const payload = {
    job_id: cryptoUuid(),
    requester_id: u.id,
    topic: body.topic,
    context: body.context ?? null,
    report_type: body.reportType,
    source_policy: body.sourcePolicy,
    source_refs: body.sourceRefs.map((r) => ({
      type: r.type,
      value: r.value,
      required: r.required,
    })),
  };

  const env = getWebEnv();
  const url = `${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/jobs`;

  let upstreamRes: Response;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), AI_ENGINE_TIMEOUT_MS);
    upstreamRes = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    log.warn('ai.bff.submit', 'upstream fetch failed', {
      requestId,
      err: serializeError(err),
      upstream: url,
    });
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: 'ai-engine 不可达',
      requestId,
    });
  }

  const upstreamBody = await upstreamRes.text();
  if (!upstreamRes.ok) {
    let parsed: { code?: string; message?: string; requestId?: string; details?: unknown } = {};
    try {
      parsed = JSON.parse(upstreamBody);
    } catch {
      // upstream 返回了非 JSON（如 nginx 502）；归一化为 503
    }
    const code = (parsed.code as keyof typeof ERROR_CODES) ?? ERROR_CODES.AI_ENGINE_UNAVAILABLE;
    return toApiErrorResponse({
      code,
      message: parsed.message ?? `ai-engine 返回 ${upstreamRes.status}`,
      requestId: parsed.requestId ?? requestId,
      details: parsed.details,
    });
  }

  let upstream: SubmitAiJobBodyOut;
  try {
    upstream = JSON.parse(upstreamBody) as SubmitAiJobBodyOut;
  } catch {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: 'ai-engine 返回非 JSON',
      requestId,
    });
  }

  log.info('ai.bff.submit', 'ok', {
    requestId,
    userId: u.id,
    jobId: upstream.job_id,
    reportType: body.reportType,
  });

  // 透传给前端：客户端拿到 jobId 后跳 /ai-research/[jobId] 然后 GET 轮询
  return NextResponse.json(
    {
      jobId: upstream.job_id,
      status: upstream.status,
      finalStatus: upstream.final_status ?? null,
      currentStep: upstream.current_step ?? null,
      sourcesCount: upstream.sources_count ?? 0,
    },
    { status: upstreamRes.status },
  );
});

/** 不依赖 node:crypto 在 Edge runtime 的兼容性 —— 用 Web Crypto。 */
function cryptoUuid(): string {
  // Next.js 默认 node runtime；这里 node:crypto.randomUUID() 更直接
  // 为避免 Edge 兼容隐患，用 Web Crypto 标准接口
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // 兜底：v4 风格拼接
  const rnd = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${rnd()}${rnd()}-${rnd()}-4${rnd().slice(1)}-${rnd()}-${rnd()}${rnd()}${rnd()}`;
}
