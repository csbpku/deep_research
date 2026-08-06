import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler } from '@/lib/api-handler';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';

const NotificationIdParam = z.object({ id: z.string().uuid() });

export const PATCH = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const parsed = NotificationIdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '通知 ID 不合法', requestId });
  }

  const result = await prisma.notification.updateMany({
    where: { id: parsed.data.id, recipientId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true, updated: result.count });
});
