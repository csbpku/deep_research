// BFF handler: GET /api/admin/radar/runs — Admin 历史同步记录。
//
// 设计：转发 ai-engine 的 /api/radar/runs；带 INTERNAL_SERVICE_TOKEN。
// 调用方 AdminConsole 用于"启动今日同步"按钮的阶段状态轮询、失败重试入口。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { getWebEnv } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/session';
import { withRequestId } from '@/lib/log';

const AI_ENGINE_TIMEOUT_MS = 10_000;

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const requestId = withRequestId(req.headers);
  const url = new URL(req.url);
  const limit = url.searchParams.get('limit') ?? '20';
  const target = `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}/api/radar/runs?limit=${encodeURIComponent(limit)}`;

  const headers: Record<string, string> = { 'x-request-id': requestId };
  const token = getWebEnv().INTERNAL_SERVICE_TOKEN;
  if (token) headers['x-internal-token'] = token;

  try {
    const r = await fetch(target, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(AI_ENGINE_TIMEOUT_MS),
      cache: 'no-store',
    });
    const text = await r.text();
    return new NextResponse(text, {
      status: r.status,
      headers: {
        'content-type': r.headers.get('content-type') ?? 'application/json',
        'x-request-id': requestId,
      },
    });
  } catch {
    return NextResponse.json(
      { code: 'AI_ENGINE_UNAVAILABLE', message: 'ai-engine 不可达', requestId },
      { status: 503 },
    );
  }
});
