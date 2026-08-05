// BFF: POST /api/admin/topic-proposals/generate — 生成待审核主题提议。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { getWebEnv } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/session';
import { withRequestId } from '@/lib/log';

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const requestId = withRequestId(req.headers);
  const url = `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}/api/topics/proposals/generate`;
  const headers: Record<string, string> = { 'x-request-id': requestId };
  const token = getWebEnv().INTERNAL_SERVICE_TOKEN;
  if (token) headers['x-internal-token'] = token;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json',
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
