// BFF handler: POST /api/researches/[id]/archive — owner/admin 归档已发布调研。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../../lib/db';
import { apiHandler } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { log, withRequestId } from '../../../../../lib/log';
import { ResearchIdParam } from '../../../../../lib/schemas';
import {
  ADMIN_RESEARCH_ACTIONS,
  newAdminActionRequestId,
} from '../../../../../lib/radar/admin-actions';
import { transitionResearchStatus } from '../../../../../lib/research-status-actions';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { RESEARCH_STATUS } from '@deep-research/shared/states';

export const POST = apiHandler<
  [NextRequest, { params: Promise<{ id: string }> }]
>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
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
    select: { id: true, authorId: true, status: true },
  });
  if (!existing) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '调研库不存在',
      requestId,
    });
  }
  if (existing.authorId !== u.id && u.role !== 'admin') {
    return toApiErrorResponse({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: '没有权限归档这份调研',
      requestId,
    });
  }
  if (existing.status !== RESEARCH_STATUS.PUBLISHED) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '只有已发布调研可以归档',
      requestId,
    });
  }

  const adminAction = u.role === 'admin'
    ? { action: ADMIN_RESEARCH_ACTIONS.ARCHIVE, requestId: newAdminActionRequestId() }
    : undefined;
  const result = await prisma.$transaction((tx) =>
    transitionResearchStatus(tx, {
      id: existing.id,
      actorId: u.id,
      action: 'archive',
      adminAction,
    }),
  );

  log.info('research.archive', 'research archived by owner/admin', {
    requestId,
    userId: u.id,
    researchId: existing.id,
    actionRequestId: result.actionRequestId ?? undefined,
  });

  return NextResponse.json({
    ok: true,
    research: {
      id: result.id,
      status: result.status,
      updatedAt: result.updatedAt.toISOString(),
    },
    actionRequestId: result.actionRequestId,
  });
});
