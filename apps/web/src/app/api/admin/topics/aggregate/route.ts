// BFF: POST /api/admin/topics/aggregate — Admin 手动触发主题聚合 (P1-D)。
// 转发到 ai-engine /api/topics/aggregate；带 INTERNAL_SERVICE_TOKEN。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { getWebEnv } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/session';
import { withRequestId } from '@/lib/log';

const AI_ENGINE_TIMEOUT_MS = 30_000;

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const requestId = withRequestId(req.headers);
  const url = `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}/api/topics/aggregate`;

  const headers: Record<string, string> = { 'x-request-id': requestId };
  const token = getWebEnv().INTERNAL_SERVICE_TOKEN;
  if (token) headers['x-internal-token'] = token;

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(AI_ENGINE_TIMEOUT_MS),
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
