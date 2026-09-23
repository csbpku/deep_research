import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler, parseBody } from '../../../../../lib/api-handler';
import { exchangeReadingAuthorizationCode, isAllowedReadingRedirect } from '../../../../../lib/reading-auth';
import { withRequestId } from '../../../../../lib/log';

const ExchangeInput = z.object({
  code: z.string().min(1).max(8_000),
  redirect: z.string().url().max(2048),
  code_verifier: z.string().min(43).max(128),
}).strict();

export const dynamic = 'force-dynamic';

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const input = await parseBody(req, ExchangeInput);
  if (input instanceof NextResponse) return input;
  if (!isAllowedReadingRedirect(input.redirect)) {
    return NextResponse.json({ ok: false, message: '阅读插件来源未获授权', requestId }, { status: 403 });
  }
  const token = await exchangeReadingAuthorizationCode({
    code: input.code,
    redirect: input.redirect,
    codeVerifier: input.code_verifier,
  });
  if (!token) {
    return NextResponse.json({ ok: false, message: '授权码无效、已过期或已使用，请重新连接', requestId }, { status: 400 });
  }
  return NextResponse.json({ ok: true, token, expiresInSeconds: 60 * 60 * 24 * 14, requestId });
});
