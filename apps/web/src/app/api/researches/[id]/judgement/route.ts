// POST /api/researches/[id]/judgement — review a knowledge card's claim.
//
// A published judgement is a promise with an expiry date. When it comes due the
// owner must either reaffirm it (extend the date), revise it (go edit), or
// archive the card. Reaffirming is recorded in research_audit so the claim's
// history is inspectable, not silently extended.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../../lib/db';
import { apiHandler, parseBody } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { log, withRequestId } from '../../../../../lib/log';
import { ResearchIdParam } from '../../../../../lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { RESEARCH_STATUS } from '@deep-research/shared/states';

export const dynamic = 'force-dynamic';

const JudgementReviewBody = z.object({
  action: z.enum(['reaffirm', 'revise', 'archive']),
  reviewAt: z.string().datetime({ offset: true }).optional(),
});

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(
  async (req, ctx) => {
    const requestId = withRequestId(req.headers);
    const user = await requireUser(req);
    if (user instanceof NextResponse) return user;

    const parsedParams = ResearchIdParam.safeParse(await ctx.params);
    if (!parsedParams.success) {
      return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: 'id 必须为 UUID', requestId });
    }
    const parsedBody = await parseBody(req, JudgementReviewBody);
    if (parsedBody instanceof NextResponse) return parsedBody;

    const existing = await prisma.research.findUnique({
      where: { id: parsedParams.data.id },
      select: {
        id: true, type: true, status: true, authorId: true,
        judgement: true, judgementReviewAt: true,
      },
    });
    if (!existing) {
      return toApiErrorResponse({ code: ERROR_CODES.DRAFT_NOT_FOUND, message: '调研库不存在', requestId });
    }
    if (existing.authorId !== user.id && user.role !== 'admin') {
      return toApiErrorResponse({ code: ERROR_CODES.PERMISSION_DENIED, message: '没有权限处理这条判断', requestId });
    }
    if (existing.type !== 'knowledge') {
      return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '只有知识卡的判断需要复查', requestId });
    }
    if (existing.status === RESEARCH_STATUS.ARCHIVED) {
      return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '已归档的知识卡没有待复查判断', requestId });
    }

    if (parsedBody.action === 'reaffirm') {
      if (!existing.judgement) {
        return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '这张卡还没有判断，先补充判断再复查', requestId });
      }
      const raw = parsedBody.reviewAt;
      const reviewAt = raw ? new Date(raw) : null;
      if (!reviewAt || Number.isNaN(reviewAt.getTime()) || reviewAt.getTime() <= Date.now()) {
        return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '复查时间必须晚于现在', requestId });
      }
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.research.update({
          where: { id: existing.id },
          data: { judgementReviewAt: reviewAt },
          select: { id: true, judgementReviewAt: true },
        });
        await tx.researchAudit.create({
          data: {
            researchId: existing.id,
            editorId: user.id,
            action: 'edit',
            diff: { judgementReviewAt: { from: existing.judgementReviewAt, to: reviewAt } },
            reason: '复查确认判断仍成立',
          },
        });
        return row;
      });
      log.info('research.judgement.reaffirmed', 'knowledge judgement reaffirmed', {
        requestId, userId: user.id, researchId: existing.id, reviewAt: reviewAt.toISOString(),
      });
      return NextResponse.json({ ok: true, id: updated.id, judgementReviewAt: updated.judgementReviewAt });
    }

    if (parsedBody.action === 'revise') {
      return NextResponse.json({ ok: true, redirectTo: `/researches/${existing.id}/edit` });
    }

    const { transitionResearchStatus } = await import('../../../../../lib/research-status-actions');
    const result = await prisma.$transaction((tx) =>
      transitionResearchStatus(tx, { id: existing.id, actorId: user.id, action: 'archive' }),
    );
    return NextResponse.json({ ok: true, id: result.id, status: result.status });
  },
);
