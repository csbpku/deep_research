// BFF handler: POST /api/admin/radar/[id]/restore —— 恢复被软屏蔽的雷达条目。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../../../lib/db';
import { apiHandler } from '../../../../../../lib/api-handler';
import { requireAdmin } from '../../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../../lib/errors';
import { log, withRequestId } from '../../../../../../lib/log';
import { RadarIdParam } from '../../../../../../lib/schemas';
import {
  ADMIN_RADAR_ACTIONS,
  ADMIN_TARGET_TYPE,
  newAdminActionRequestId,
  writeAdminAction,
} from '../../../../../../lib/radar/admin-actions';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { SUMMARY_STATUS } from '@deep-research/shared/states';

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const parsed = RadarIdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const existing = await prisma.summary.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      source: true,
      syncRunId: true,
      status: true,
      shareSource: { select: { status: true } },
    },
  });
  const isAutomaticRadar = existing?.source === 'daily' && existing.syncRunId !== null;
  const isApprovedShare = existing?.source === 'user' && existing.shareSource?.status === 'approved';
  if (!existing || (!isAutomaticRadar && !isApprovedShare)) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '雷达条目不存在',
      requestId,
    });
  }
  if (existing.status !== SUMMARY_STATUS.REJECTED) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '只有已屏蔽条目可以恢复',
      requestId,
    });
  }

  const actionRequestId = newAdminActionRequestId();
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.summary.update({
      where: { id: existing.id },
      data: { status: SUMMARY_STATUS.CANDIDATE },
      select: { id: true, status: true, updatedAt: true },
    });
    await writeAdminAction(tx, {
      actorId: user.id,
      action: ADMIN_RADAR_ACTIONS.RESTORE,
      targetType: ADMIN_TARGET_TYPE.RADAR_SUMMARY,
      targetId: existing.id,
      requestId: actionRequestId,
      metadata: { previousStatus: existing.status },
    });
    return updated;
  });

  log.info('admin.radar.restore', 'radar item restored', {
    requestId,
    userId: user.id,
    summaryId: existing.id,
    actionRequestId,
  });

  return NextResponse.json({
    ok: true,
    summary: {
      id: result.id,
      status: result.status,
      updatedAt: result.updatedAt.toISOString(),
    },
    actionRequestId,
  });
});
