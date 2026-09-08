// BFF: POST /api/admin/topics/regenerate — Admin 一键重新发现热点主题。
//
// 串行调用 ai-engine：
//   1) POST /api/topics/aggregate         清掉非 deep_read/collection 旧 candidates
//   2) POST /api/topics/synthesize-v2     candidate 变化触发 hash-gated 重生成
//   3) POST /api/topics/proposals/generate LLM 找新候选簇，提交 admin 审核
//
// 任意一步失败立刻中止并返回之前的部分结果 + 错误码，方便定位哪一段挂了。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { getWebEnv } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/session';
import { withRequestId } from '@/lib/log';

const AGGREGATE_TIMEOUT_MS = 60_000;
const SYNTHESIS_TIMEOUT_MS = 300_000;
const PROPOSALS_TIMEOUT_MS = 300_000;

interface AiCallResult {
  ok: boolean;
  status: number;
  body: unknown;
}

async function callAiEngine(
  path: string,
  requestId: string,
  token: string,
  timeoutMs: number,
): Promise<AiCallResult> {
  const url = `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}${path}`;
  const headers: Record<string, string> = { 'x-request-id': requestId };
  if (token) headers['x-internal-token'] = token;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { ok: response.ok, status: response.status, body };
  } catch {
    return {
      ok: false,
      status: 503,
      body: { code: 'AI_ENGINE_UNAVAILABLE', message: 'ai-engine 不可达' },
    };
  }
}

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const requestId = withRequestId(req.headers);
  const token = getWebEnv().INTERNAL_SERVICE_TOKEN;

  const aggregate = await callAiEngine(
    '/api/topics/aggregate',
    requestId,
    token,
    AGGREGATE_TIMEOUT_MS,
  );
  if (!aggregate.ok) {
    return NextResponse.json(
      { code: 'TOPIC_REGENERATE_AGGREGATE_FAILED', aggregate, requestId },
      { status: 502 },
    );
  }

  const synthesis = await callAiEngine(
    '/api/topics/synthesize-v2',
    requestId,
    token,
    SYNTHESIS_TIMEOUT_MS,
  );
  if (!synthesis.ok) {
    return NextResponse.json(
      { code: 'TOPIC_REGENERATE_SYNTHESIS_FAILED', aggregate, synthesis, requestId },
      { status: 502 },
    );
  }

  const proposals = await callAiEngine(
    '/api/topics/proposals/generate',
    requestId,
    token,
    PROPOSALS_TIMEOUT_MS,
  );
  if (!proposals.ok) {
    return NextResponse.json(
      { code: 'TOPIC_REGENERATE_PROPOSALS_FAILED', aggregate, synthesis, proposals, requestId },
      { status: 502 },
    );
  }

  return NextResponse.json({ aggregate, synthesis, proposals, requestId });
});
