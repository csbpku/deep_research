// BFF handler: POST /api/admin/radar/[id]/retry-interpretation — Admin 触发重做 AI 解读。
//
// 行为：requireAdmin → 校验来源 → 重置 status='candidate' + 清空 interpretation
// （ai-engine 那边会异步重跑，本周为占位） + write admin_action。
//
// 同步重跑由 packages/ai-engine/ 负责；本 endpoint 只负责状态回滚和审计。

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

  const existing = await prisma.summary.findUnique({
    where: { id: idParsed.data.id },
    select: {
      id: true,
      source: true,
      syncRunId: true,
      status: true,
      syncRun: { select: { id: true } },
    },
  });
  if (!existing || existing.source !== 'daily' || existing.syncRunId === null) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '雷达候选不存在',
      requestId,
    });
  }

  const actionRequestId = newAdminActionRequestId();

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.summary.update({
      where: { id: existing.id },
      data: {
        status: SUMMARY_STATUS.CANDIDATE,
        interpretation: null,
        // 清空评分让 ai-engine 重新打分；保留 syncRunId 以便 worker 知道来源批次
        relevanceScore: null,
        timelinessScore: null,
        sourceQualityScore: null,
        scoreReason: null,
        scoreVersion: null,
      },
      select: { id: true, status: true, interpretation: true, updatedAt: true },
    });
    await writeAdminAction(tx, {
      actorId: u.id,
      action: ADMIN_RADAR_ACTIONS.RETRY_INTERPRETATION,
      targetType: ADMIN_TARGET_TYPE.RADAR_SUMMARY,
      targetId: existing.id,
      requestId: actionRequestId,
      metadata: {
        previousStatus: existing.status,
        syncRunId: existing.syncRun?.id ?? null,
      },
    });
    return updated;
  });

  log.info('admin.radar.retry', 'candidate reset for re-interpretation', {
    requestId,
    userId: u.id,
    summaryId: existing.id,
    previousStatus: existing.status,
    actionRequestId,
  });

  return NextResponse.json({
    ok: true,
    summary: {
      id: result.id,
      status: result.status,
      interpretation: result.interpretation,
      updatedAt: result.updatedAt.toISOString(),
    },
    actionRequestId,
    note: 'ai-engine worker 会在下一轮抓取或 cron 触发时重新跑解读',
  });
});