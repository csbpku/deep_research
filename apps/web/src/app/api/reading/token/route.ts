import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { apiHandler } from '../../../../lib/api-handler';
import { requireUser } from '../../../../lib/auth/session';
import { isAllowedReadingRedirect, issueReadingAuthorizationCode, issueReadingToken } from '../../../../lib/reading-auth';
import { withRequestId } from '../../../../lib/log';

export const dynamic = 'force-dynamic';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const redirect = new URL(req.url).searchParams.get('redirect');
  if (redirect && !isAllowedReadingRedirect(redirect)) {
    return NextResponse.json({ ok: false, message: '阅读插件来源未获授权' }, { status: 403 });
  }
  const params = new URL(req.url).searchParams;
  const challenge = params.get('code_challenge');
  const method = params.get('code_challenge_method');
  if (challenge || method) {
    if (!redirect || method !== 'S256' || !challenge || !/^[A-Za-z0-9_-]{43,128}$/u.test(challenge)) {
      return NextResponse.json({ ok: false, message: 'PKCE 授权参数无效' }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      code: issueReadingAuthorizationCode(user.id, redirect, challenge),
      expiresInSeconds: 5 * 60,
      requestId: withRequestId(req.headers),
    });
  }
  // Keep the direct token response for older unpacked prototypes. New
  // extension builds always use the code + PKCE exchange below. Production
  // refuses the legacy path so an access grant never travels in a URL.
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ ok: false, message: '生产环境必须使用 PKCE 授权' }, { status: 400 });
  }
  return NextResponse.json({ ok: true, token: issueReadingToken(user.id), expiresInSeconds: 60 * 60 * 24 * 14, requestId: withRequestId(req.headers) });
});
