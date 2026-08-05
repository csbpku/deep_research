// BFF handler: GET / PUT /api/me/preferences — 读 / 写当前用户 preferences (P1-C)。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { userPreferencesSchema } from '@/lib/me/preferences-schema';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const requestId = withRequestId(req.headers);
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { preferences: true },
  });
  const parsed = userPreferencesSchema.safeParse(row?.preferences ?? {});
  return NextResponse.json({
    preferences: parsed.success ? parsed.data : {},
    requestId,
  });
});

export const PUT = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const requestId = withRequestId(req.headers);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '请求体必须为 JSON',
      requestId,
    });
  }

  const parsed = userPreferencesSchema.safeParse(raw);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      requestId,
    });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { preferences: parsed.data as Prisma.JsonObject },
  });

  return NextResponse.json({ ok: true, preferences: parsed.data, requestId });
});
