import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { getWebEnv } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/session';
import { withRequestId } from '@/lib/log';

const AI_ENGINE_TIMEOUT_MS = 10_000;

/** P1-A2: forward the shared INTERNAL_SERVICE_TOKEN so ai-engine can trust
 * the request originated from the BFF. Empty token in dev is allowed — the
 * ai-engine side honors RADAR_DISABLE_INTERNAL_TOKEN=1; production MUST set
 * both. The token itself is never echoed back in the response or logs.
 */
function internalTokenHeader(): Record<string, string> {
  const token = getWebEnv().INTERNAL_SERVICE_TOKEN;
  return token ? { 'x-internal-token': token } : {};
}

export async function forwardAdminRadarAction(
  req: NextRequest,
  path: string,
  body: object,
): Promise<NextResponse> {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const requestId = withRequestId(req.headers);
  const url = `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}${path}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId,
        ...internalTokenHeader(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AI_ENGINE_TIMEOUT_MS),
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
      {
        code: 'AI_ENGINE_UNAVAILABLE',
        message: 'ai-engine 不可达',
        requestId,
      },
      { status: 503 },
    );
  }
}
