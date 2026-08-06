// BFF handler: POST /api/admin/researches/[id]/restore — Admin 恢复归档调研。
//
// 行为：requireAdmin → 校验 archived → $transaction(update status='published' +
// research_audit + admin_action)。publishedAt 保留原值，缺失时补当前时间，
// 避免触发 published 必须带 publishedAt 的 CHECK 约束。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../../../lib/db';
import { apiHandler } from '../../../../../../lib/api-handler';
import { requireAdmin } from '../../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../../lib/errors';
import { log, withRequestId } from '../../../../../../lib/log';
import { ResearchIdParam } from '../../../../../../lib/schemas';
import {
  ADMIN_RESEARCH_ACTIONS,
  newAdminActionRequestId,
} from '../../../../../../lib/radar/admin-actions';
import { transitionResearchStatus } from '../../../../../../lib/research-status-actions';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { RESEARCH_STATUS } from '@deep-research/shared/states';

export const POST = apiHandler<
  [NextRequest, { params: Promise<{ id: string }> }]
>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const parsed = ResearchIdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const existing = await prisma.research.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, status: true, publishedAt: true },
  });
  if (!existing) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '调研库不存在',
      requestId,
    });
  }
  if (existing.status !== RESEARCH_STATUS.ARCHIVED) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '只有已归档调研可以恢复',
      requestId,
    });
  }

  const actionRequestId = newAdminActionRequestId();
  const result = await prisma.$transaction((tx) =>
    transitionResearchStatus(tx, {
      id: existing.id,
      actorId: u.id,
      action: 'restore',
      adminAction: {
        action: ADMIN_RESEARCH_ACTIONS.RESTORE,
        requestId: actionRequestId,
      },
    }),
  );

  log.info('admin.research.restore', 'research restored', {
    requestId,
    userId: u.id,
    researchId: existing.id,
    actionRequestId,
  });

  return NextResponse.json({
    ok: true,
    research: {
      id: result.id,
      status: result.status,
      updatedAt: result.updatedAt.toISOString(),
    },
    actionRequestId,
  });
});
