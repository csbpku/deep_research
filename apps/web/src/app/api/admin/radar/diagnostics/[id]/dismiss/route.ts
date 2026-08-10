// Admin 忽略一条被过滤候选。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { requireAdmin } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import {
  ADMIN_RADAR_ACTIONS,
  ADMIN_TARGET_TYPE,
  newAdminActionRequestId,
  writeAdminAction,
} from '@/lib/radar/admin-actions';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(
  async (req, ctx) => {
    const requestId = withRequestId(req.headers);
    const admin = await requireAdmin(req);
    if (admin instanceof NextResponse) return admin;
    const id = (await ctx.params).id;
    const actionRequestId = newAdminActionRequestId();
    const existing = await prisma.radarSyncDiagnostic.findUnique({
      where: { id },
      select: { id: true, kind: true, status: true },
    });
    if (!existing || existing.kind !== 'filtered' || existing.status !== 'pending') {
      return toApiErrorResponse({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: '该过滤记录不存在或已处理',
        requestId,
      });
    }
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.radarSyncDiagnostic.update({
        where: { id },
        data: { status: 'dismissed' },
        select: { id: true, status: true },
      });
      await writeAdminAction(tx, {
        actorId: admin.id,
        action: ADMIN_RADAR_ACTIONS.DISMISS_DIAGNOSTIC,
        targetType: ADMIN_TARGET_TYPE.RADAR_DIAGNOSTIC,
        targetId: id,
        requestId: actionRequestId,
      });
      return updated;
    });
    return NextResponse.json({ ok: true, diagnostic: result, actionRequestId, requestId });
  },
);
