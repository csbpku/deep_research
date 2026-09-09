import { NextResponse } from 'next/server';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';

export const runtime = 'nodejs';

/**
 * Kept as a stable compatibility endpoint for older clients. Public account
 * creation is intentionally disabled; password accounts are activated through
 * /api/auth/activate with an allowlisted email and invite code.
 */
export async function POST(request: Request) {
  return toApiErrorResponse({
    code: ERROR_CODES.AUTH_REGISTRATION_DISABLED,
    message: '公开注册已关闭，请使用邀请码激活邮箱密码账号',
    requestId: withRequestId(request.headers),
  });
}

export function GET() {
  return NextResponse.json(
    { ok: false, code: ERROR_CODES.AUTH_REGISTRATION_DISABLED },
    { status: 403 },
  );
}
