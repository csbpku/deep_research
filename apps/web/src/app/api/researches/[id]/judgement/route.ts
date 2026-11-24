// POST /api/researches/[id]/judgement — review a knowledge card's claim.
//
// A published judgement is a promise with an expiry date. When it comes due the
// owner must either reaffirm it (extend the date), revise the judgement, or
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
import { validateKnowledgeJudgement } from '../../../../../lib/research-knowledge-judgement';
import { knowledgeCardIndexText, queuePersonalKnowledgeIndex } from '../../../../../lib/personal-knowledge-index';

export const dynamic = 'force-dynamic';

const JudgementReviewBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reaffirm'), reviewAt: z.string().datetime({ offset: true }).optional() }),
  z.object({
    action: z.literal('revise'),
    judgement: z.string().max(500),
    judgementConfidence: z.enum(['low', 'medium', 'high']),
    judgementScope: z.string().max(500),
    judgementReviewAt: z.string().datetime({ offset: true }),
  }),
  z.object({ action: z.literal('archive') }),
]);

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
        title: true, body: true, conclusion: true, updatedAt: true,
        judgement: true, judgementConfidence: true, judgementScope: true, judgementReviewAt: true,
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
      const judgement = validateKnowledgeJudgement(parsedBody);
      if (!judgement.ok) {
        return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: judgement.message, requestId });
      }
      if (existing.status !== RESEARCH_STATUS.PUBLISHED) {
        return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '只有已发布的判断需要修订复查', requestId });
      }
      const revised = judgement.value;
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.research.updateMany({
          where: { id: existing.id, status: RESEARCH_STATUS.PUBLISHED, updatedAt: existing.updatedAt },
          data: { ...revised, knowledgeIndexText: knowledgeCardIndexText({ ...existing, ...revised }) },
        });
        if (result.count !== 1) return false;
        await tx.researchAudit.create({
          data: {
            researchId: existing.id,
            editorId: user.id,
            action: 'edit',
            reason: '复查后修订知识卡判断',
            diff: {
              judgement: { from: existing.judgement, to: revised.judgement },
              judgementConfidence: { from: existing.judgementConfidence, to: revised.judgementConfidence },
              judgementScope: { from: existing.judgementScope, to: revised.judgementScope },
              judgementReviewAt: { from: existing.judgementReviewAt?.toISOString() ?? null, to: revised.judgementReviewAt.toISOString() },
            },
          },
        });
        await queuePersonalKnowledgeIndex(tx, { ownerId: existing.authorId, researchId: existing.id, operation: 'upsert' });
        return true;
      });
      if (!updated) {
        return toApiErrorResponse({ code: ERROR_CODES.AI_REVIEW_CONFLICT, message: '知识卡已更新，请刷新后重新修订判断', requestId });
      }
      return NextResponse.json({ ok: true, id: existing.id, ...revised });
    }

    const { transitionResearchStatus } = await import('../../../../../lib/research-status-actions');
    const result = await prisma.$transaction((tx) =>
      transitionResearchStatus(tx, { id: existing.id, actorId: user.id, action: 'archive' }),
    );
    return NextResponse.json({ ok: true, id: result.id, status: result.status });
  },
);
