// BFF handler: POST /api/researches/[id]/review — re-review an edited draft.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { apiHandler } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { prisma } from '../../../../../lib/db';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { fetchAiEngine } from '../../../../../lib/ai-bff/fetch-ai-engine';
import { getWebEnv } from '../../../../../lib/env';
import { withRequestId } from '../../../../../lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';

const IdParam = z.object({ id: z.string().uuid() });

interface ReviewResponse {
  review?: Record<string, unknown>;
}

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const parsed = IdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const research = await prisma.research.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      authorId: true,
      status: true,
      title: true,
      body: true,
      researchSources: {
        orderBy: { createdAt: 'asc' },
        select: { sourceRef: true, canonicalKey: true, title: true, description: true },
      },
    },
  });
  if (!research || research.authorId !== user.id || research.status !== 'draft') {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '草稿不存在',
      requestId,
    });
  }

  const env = getWebEnv();
  const upstream = await fetchAiEngine<ReviewResponse>({
    url: `${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/review`,
    method: 'POST',
    timeoutMs: 75_000,
    body: {
      topic: research.title,
      report: research.body,
      sources: research.researchSources,
    },
    requestId,
    context: 'ai.bff.review',
  });
  if (!upstream.ok || !upstream.body.review) {
    return toApiErrorResponse({
      code: upstream.ok ? ERROR_CODES.AI_ENGINE_UNAVAILABLE : upstream.code,
      message: upstream.ok ? '审核服务返回了无效结果' : upstream.message,
      requestId: upstream.ok ? requestId : upstream.requestId,
    });
  }

  const review = upstream.body.review;
  const claims = Array.isArray(review.claims) ? review.claims : [];
  const summary = {
    corrected_count: typeof review.corrected_count === 'number' ? review.corrected_count : 0,
    unverified_count: typeof review.unverified_count === 'number' ? review.unverified_count : 0,
    contradicted_count: typeof review.contradicted_count === 'number' ? review.contradicted_count : 0,
  };
  const updated = await prisma.research.update({
    where: { id: research.id },
    data: {
      reviewStatus: typeof review.status === 'string' ? review.status : 'review_unavailable',
      reviewAttempts: typeof review.attempts === 'number' ? review.attempts : 1,
      reviewSummary: summary as Prisma.InputJsonValue,
      reviewClaims: claims as Prisma.InputJsonValue,
      reviewDetails: review as Prisma.InputJsonValue,
      reviewedAt: new Date(),
    },
    select: { reviewStatus: true, reviewAttempts: true, reviewSummary: true, reviewClaims: true, reviewDetails: true, reviewedAt: true },
  });
  return NextResponse.json({
    status: updated.reviewStatus,
    attempts: updated.reviewAttempts,
    summary: updated.reviewSummary,
    claims: updated.reviewClaims,
    details: updated.reviewDetails,
    reviewedAt: updated.reviewedAt?.toISOString() ?? null,
  });
});
