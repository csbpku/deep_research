// POST /api/researches/[id]/review/decisions/batch
// Accept a set of low/medium-risk, still-unverified factual claims as
// acknowledged uncertainty in one audit operation. This is the bulk form of
// `accept_uncertainty`; it never accepts contradictions or high-risk claims.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../../../../lib/db';
import { apiHandler, parseBody } from '../../../../../../../lib/api-handler';
import { requireUser } from '../../../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../../../lib/errors';
import { withRequestId } from '../../../../../../../lib/log';
import { hashResearchRevision } from '../../../../../../../lib/research-revision';
import {
  asReviewClaims,
  claimEvidenceStatus,
  claimIsFactual,
  getReviewPublicationGate,
  reviewClaimId,
  reviewCoverageStatus,
} from '../../../../../../../lib/research-review-decisions';
import { resolveCurrentReviewState } from '../../../../../../../lib/research-review-state';
import { evaluateResearchSufficiency } from '../../../../../../../lib/research-sufficiency';
import { ResearchBriefSchema } from '@deep-research/shared/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';

const IdParam = z.object({ id: z.string().uuid() });
const BatchInput = z.object({
  runId: z.string().uuid().optional(),
  claimIds: z.array(z.string().trim().min(1).max(160)).min(1).max(500),
  reason: z.string().trim().min(5).max(2_000),
});

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
  const input = await parseBody(req, BatchInput);
  if (input instanceof NextResponse) return input;
  const claimIds = [...new Set(input.claimIds)];

  const research = await prisma.research.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      authorId: true,
      status: true,
      creationMethod: true,
      title: true,
      body: true,
      background: true,
      conclusion: true,
      risks: true,
      tags: true,
      reviewStatus: true,
      sourceAiJob: {
        select: {
          id: true,
          partialSources: true,
          brief: true,
          sourcePolicy: true,
          aiResearchSources: {
            orderBy: { createdAt: 'asc' as const },
            select: { canonicalKey: true, title: true, snippet: true },
          },
        },
      },
      researchSources: {
        orderBy: { createdAt: 'asc' as const },
        select: { sourceRef: true, canonicalKey: true, title: true, description: true },
      },
      reviewRuns: {
        orderBy: { createdAt: 'desc' as const },
        take: 50,
        select: {
          id: true,
          revisionHash: true,
          executionStatus: true,
          outcome: true,
          attempt: true,
          summary: true,
          claims: true,
          decisions: {
            orderBy: { createdAt: 'asc' as const },
            select: { id: true, claimId: true, revisionHash: true, action: true, reason: true, metadata: true, actorId: true, createdAt: true },
          },
        },
      },
    },
  });
  if (!research || research.status !== 'draft' || (research.authorId !== user.id && user.role !== 'admin')) {
    return toApiErrorResponse({ code: ERROR_CODES.DRAFT_NOT_FOUND, message: '草稿不存在', requestId });
  }
  if (research.creationMethod !== 'ai_research') {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '只有 AI 调研草稿支持声明处理',
      requestId,
    });
  }

  const revisionHash = hashResearchRevision(research);
  const state = resolveCurrentReviewState(research, research.reviewRuns, research.reviewStatus);
  const run = state.run;
  if (!run || !state.isCurrentRevision || run.executionStatus !== 'completed') {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_REVIEW_CONFLICT,
      message: '当前版本还没有可处理的完整审核结果，请刷新后重试。',
      requestId,
      details: { reviewStatus: state.status, runId: run?.id ?? null },
    });
  }
  if (input.runId && input.runId !== run.id) {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_REVIEW_CONFLICT,
      message: '审核结果已更新，请刷新后重新处理。',
      requestId,
      details: { expectedRunId: run.id, receivedRunId: input.runId },
    });
  }

  const claims = asReviewClaims(run.claims);
  const claimById = new Map(claims.map((claim) => [reviewClaimId(claim), claim]));
  const alreadyDecided = new Set((run.decisions ?? []).map((decision) => decision.claimId));
  const ineligible: Array<{ claimId: string; reason: string }> = [];
  for (const claimId of claimIds) {
    const claim = claimById.get(claimId);
    if (!claim) {
      ineligible.push({ claimId, reason: 'missing' });
      continue;
    }
    if (alreadyDecided.has(claimId)) {
      ineligible.push({ claimId, reason: 'already_decided' });
      continue;
    }
    if (!claimIsFactual(claim)) {
      ineligible.push({ claimId, reason: 'not_factual' });
      continue;
    }
    if (claimEvidenceStatus(claim) !== 'unverified') {
      ineligible.push({ claimId, reason: 'evidence_conflict_or_supported' });
      continue;
    }
    if (claim.risk?.toLowerCase() === 'high') {
      ineligible.push({ claimId, reason: 'high_risk' });
    }
  }
  if (ineligible.length > 0) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '这些声明不能批量接受为待验证项。',
      requestId,
      details: { ineligible },
    });
  }

  const result = await prisma.$transaction(async (tx) => {
    const freshResearch = await tx.research.findUnique({
      where: { id: research.id },
      select: {
        id: true,
        title: true,
        body: true,
        background: true,
        conclusion: true,
        risks: true,
        tags: true,
        sourceAiJob: {
          select: {
            id: true,
            brief: true,
            sourcePolicy: true,
            partialSources: true,
            aiResearchSources: { orderBy: { createdAt: 'asc' as const }, select: { canonicalKey: true, title: true, snippet: true } },
          },
        },
        researchSources: {
          orderBy: { createdAt: 'asc' as const },
          select: { sourceRef: true, canonicalKey: true, title: true, description: true },
        },
      },
    });
    const freshRun = await tx.researchReviewRun.findUnique({
      where: { id: run.id },
      select: { id: true, revisionHash: true, executionStatus: true, outcome: true, summary: true, claims: true, decisions: true },
    });
    if (
      !freshResearch
      || !freshRun
      || freshRun.executionStatus !== 'completed'
      || freshRun.revisionHash !== hashResearchRevision(freshResearch)
      || freshRun.revisionHash !== revisionHash
    ) {
      throw new Error('REVIEW_DECISION_STALE');
    }
    const freshClaims = asReviewClaims(freshRun.claims);
    const records = claimIds.map((claimId) => {
      const claim = freshClaims.find((item) => reviewClaimId(item) === claimId);
      return {
        researchReviewRunId: freshRun.id,
        claimId,
        revisionHash,
        action: 'accept_uncertainty' as const,
        reason: input.reason.trim(),
        metadata: {
          machineVerdict: claim?.verdict ?? null,
          machineRisk: claim?.risk ?? null,
          evidenceStatus: claimEvidenceStatus(claim ?? {}),
          bulk: true,
          bulkSize: claimIds.length,
        },
        actorId: user.id,
      };
    });
    await tx.researchReviewDecision.createMany({ data: records });
    const decisions = await tx.researchReviewDecision.findMany({
      where: { researchReviewRunId: freshRun.id },
      select: { id: true, claimId: true, revisionHash: true, action: true, reason: true, metadata: true, actorId: true, createdAt: true },
    });
    const brief = ResearchBriefSchema.safeParse(freshResearch.sourceAiJob?.brief);
    const sufficiency = evaluateResearchSufficiency({
      brief: brief.success ? brief.data : null,
      sources: freshResearch.sourceAiJob?.aiResearchSources ?? [],
      reportContent: freshResearch.body,
      sourcePolicy: freshResearch.sourceAiJob?.sourcePolicy ?? (brief.success ? brief.data.sourcePolicy : null),
    });
    const gate = getReviewPublicationGate({
      executionStatus: freshRun.executionStatus,
      outcome: freshRun.outcome,
      coverageStatus: reviewCoverageStatus(freshRun.summary),
      researchSufficiencyStatus: sufficiency.status,
      claims: freshRun.claims,
      decisions,
    });
    return { acceptedCount: records.length, gate };
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'REVIEW_DECISION_STALE') return null;
    throw error;
  });

  if (!result) {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_REVIEW_CONFLICT,
      message: '审核结果已更新，请刷新后重新处理。',
      requestId,
    });
  }
  return NextResponse.json({
    acceptedCount: result.acceptedCount,
    publicationGate: { status: result.gate.status, openCount: result.gate.openCount },
  }, { status: 201 });
});
