// BFF handler: POST /api/admin/radar/submissions/[id]/retry — Admin 重试 failed submission。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth/session';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { enqueueRadarSubmission } from '@/lib/radar/submissions/worker-bridge';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const requestId = withRequestId(req.headers);
  const { id } = await ctx.params;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: 'id 必须为 UUID', requestId });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const sub = await tx.radarSubmission.findUnique({ where: { id }, select: { id: true, status: true, submitterId: true } });
    if (!sub) throw new Error('NOT_FOUND');
    if (sub.status !== 'failed') throw new Error('NOT_FAILED');
    return tx.radarSubmission.update({
      where: { id },
      data: { status: 'received', errorCode: null, errorMessage: null, nextRetryAt: null },
      select: { id: true, status: true },
    });
  }).catch((err: Error) => ({ __error: err.message }));

  if ('__error' in updated) {
    if (updated.__error === 'NOT_FOUND') {
      return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: 'submission 不存在', requestId });
    }
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '仅 failed 状态的 submission 可重试',
      requestId,
    });
  }

  await tx_audit(admin.id, id);
  enqueueRadarSubmission(updated.id).catch((err) => {
    console.error('[radar-submission-retry] enqueue failed', { id: updated.id, err });
  });

  return NextResponse.json({ ok: true, submission: { id: updated.id, status: updated.status }, requestId });
});

async function tx_audit(actorId: string, targetId: string) {
  await prisma.adminAction.create({
    data: {
      actorId,
      action: 'radar_submission.retry',
      targetType: 'radar_submission',
      targetId,
      requestId: crypto.randomUUID(),
      metadata: {} as Prisma.JsonObject,
    },
  });
}
