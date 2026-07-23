// BFF handler: POST /api/admin/radar/[id]/select — Admin 把雷达候选选入指定日期的每日摘要。
//
// 契约源：
//   - docs/agent-prompts/week5-engineer-a.md §任务 3
//   - apps/web/prisma/schema.prisma: Summary + AdminAction
//
// 行为：requireAdmin → 校验 summary 来自雷达 → $transaction(update summary +
// write admin_action)。每日期最多 4 条：超出 422 VALIDATION_FAILED。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../../../lib/db';
import { apiHandler, parseBody } from '../../../../../../lib/api-handler';
import { requireAdmin } from '../../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../../lib/errors';
import { log, withRequestId } from '../../../../../../lib/log';
import { AdminRadarSelectInput, RadarIdParam } from '../../../../../../lib/schemas';
import { parseUtcDate } from '../../../../../../lib/radar/shape';
import {
  ADMIN_RADAR_ACTIONS,
  ADMIN_TARGET_TYPE,
  newAdminActionRequestId,
  writeAdminAction,
} from '../../../../../../lib/radar/admin-actions';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { SUMMARY_STATUS } from '@deep-research/shared/states';

export const POST = apiHandler<[NextRequest, { params: { id: string } }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const idParsed = RadarIdParam.safeParse(ctx.params);
  if (!idParsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: idParsed.error.flatten(),
    });
  }
  const body = await parseBody(req, AdminRadarSelectInput);
  if (body instanceof NextResponse) return body;

  const summaryDate = parseUtcDate(body.summaryDate);

  const existing = await prisma.summary.findUnique({
    where: { id: idParsed.data.id },
    select: {
      id: true,
      source: true,
      syncRunId: true,
      status: true,
      summaryDate: true,
      sortOrder: true,
    },
  });
  if (!existing || existing.source !== 'daily' || existing.syncRunId === null) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '雷达候选不存在',
      requestId,
    });
  }

  // 同日 sortOrder 占用校验（含当前 summary 自己的旧位）
  const conflicting = await prisma.summary.findFirst({
    where: {
      summaryDate,
      status: SUMMARY_STATUS.PUBLISHED,
      sortOrder: body.sortOrder,
      NOT: { id: existing.id },
    },
    select: { id: true },
  });
  if (conflicting) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: `同日 sortOrder=${body.sortOrder} 已被占用，请先调整该位置的条目`,
      requestId,
    });
  }

  // 当日已发布数量 + 待插入数量是否 ≤ 4
  const publishedToday = await prisma.summary.count({
    where: {
      summaryDate,
      status: SUMMARY_STATUS.PUBLISHED,
      NOT: { id: existing.id },
    },
  });
  const wouldBeTotal = publishedToday + 1; // 当前候选加入后总数
  if (wouldBeTotal > 4) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: `每日摘要最多 4 条；该日期已有 ${publishedToday} 条；如需替换请先归档现有条目`,
      requestId,
    });
  }

  const actionRequestId = newAdminActionRequestId();

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.summary.update({
      where: { id: existing.id },
      data: {
        status: SUMMARY_STATUS.PUBLISHED,
        summaryDate,
        sortOrder: body.sortOrder,
        selectionReason: body.selectionReason,
        publishedAt: new Date(),
      },
      select: {
        id: true,
        status: true,
        summaryDate: true,
        sortOrder: true,
        selectionReason: true,
        publishedAt: true,
      },
    });
    await writeAdminAction(tx, {
      actorId: u.id,
      action: ADMIN_RADAR_ACTIONS.SELECT,
      targetType: ADMIN_TARGET_TYPE.RADAR_SUMMARY,
      targetId: existing.id,
      requestId: actionRequestId,
      metadata: {
        summaryDate: body.summaryDate,
        sortOrder: body.sortOrder,
        selectionReasonLength: body.selectionReason.length,
      },
    });
    return updated;
  });

  log.info('admin.radar.select', 'candidate published to summary', {
    requestId,
    userId: u.id,
    summaryId: existing.id,
    summaryDate: body.summaryDate,
    sortOrder: body.sortOrder,
    actionRequestId,
  });

  return NextResponse.json({
    ok: true,
    summary: {
      id: result.id,
      status: result.status,
      summaryDate: result.summaryDate.toISOString().slice(0, 10),
      sortOrder: result.sortOrder,
      selectionReason: result.selectionReason,
      publishedAt: result.publishedAt?.toISOString() ?? null,
    },
    actionRequestId,
  });
});