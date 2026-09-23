import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '../../../../../lib/api-handler';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { withRequestId } from '../../../../../lib/log';
import { requireReadingUser, revokeReadingToken } from '../../../../../lib/reading-auth';

export const dynamic = 'force-dynamic';

/** Revoke the specific extension grant presented by the caller. */
export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const authorization = req.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) {
    return toApiErrorResponse({ code: 'AUTH_NOT_AUTHENTICATED', message: '缺少阅读令牌', requestId });
  }
  const user = await requireReadingUser(req);
  if (user instanceof Response) return user;
  const revoked = await revokeReadingToken(token, user.id);
  if (!revoked) {
    return toApiErrorResponse({ code: 'AUTH_NOT_AUTHENTICATED', message: '阅读令牌无效或已过期', requestId });
  }
  return NextResponse.json({ ok: true, revoked: true, requestId });
});
