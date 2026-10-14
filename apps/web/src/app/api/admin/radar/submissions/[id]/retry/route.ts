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

class SubmissionNotFoundError extends Error {}
class SubmissionNotFailedError extends Error {}

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
    if (!sub) throw new SubmissionNotFoundError();
    if (sub.status !== 'failed') throw new SubmissionNotFailedError();
    // 以 status='failed' 为前置条件的条件更新，防止并发重试/状态变化被覆盖。
    const claimed = await tx.radarSubmission.updateMany({
      where: { id, status: 'failed' },
      data: { status: 'received', errorCode: null, errorMessage: null, nextRetryAt: null },
    });
    if (claimed.count === 0) throw new SubmissionNotFailedError();
    return { id, status: 'received' as const };
  }).catch((err: unknown) => {
    // 只映射预期的“不存在/状态不对”；数据库故障等真实错误必须照常抛出（500 + 日志）。
    if (err instanceof SubmissionNotFoundError) return { __error: 'NOT_FOUND' as const };
    if (err instanceof SubmissionNotFailedError) return { __error: 'NOT_FAILED' as const };
    throw err;
  });

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
