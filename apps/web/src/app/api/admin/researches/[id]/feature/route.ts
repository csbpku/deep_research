// BFF handler: POST /api/admin/researches/[id]/feature — Admin 设为精华。

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
import { setResearchFeatured } from '../../../../../../lib/research-status-actions';
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
    select: { id: true, status: true, featuredAt: true },
  });
  if (!existing) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '调研库不存在',
      requestId,
    });
  }
  if (existing.status !== RESEARCH_STATUS.PUBLISHED) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '只有已发布调研可以设为精华',
      requestId,
    });
  }
  if (existing.featuredAt) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '这份调研已经是精华',
      requestId,
    });
  }

  const actionRequestId = newAdminActionRequestId();
  const result = await prisma.$transaction((tx) =>
    setResearchFeatured(tx, {
      id: existing.id,
      actorId: u.id,
      featured: true,
      adminAction: {
        action: ADMIN_RESEARCH_ACTIONS.FEATURE,
        requestId: actionRequestId,
      },
    }),
  );

  log.info('admin.research.feature', 'research featured', {
    requestId,
    userId: u.id,
    researchId: existing.id,
    actionRequestId,
  });

  return NextResponse.json({
    ok: true,
    research: {
      id: result.id,
      featuredAt: result.featuredAt?.toISOString() ?? null,
      updatedAt: result.updatedAt.toISOString(),
    },
    actionRequestId,
  });
});
