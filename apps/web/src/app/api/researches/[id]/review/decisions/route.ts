// POST /api/researches/[id]/review/decisions
// Record a human disposition for one claim in the current, completed review
// run. The machine verdict remains immutable. A verification request also
// queues the replacement run in the same transaction, so the audit record and
// the recoverable workflow cannot diverge.

import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { apiHandler, parseBody } from '../../../../../../lib/api-handler';
import { requireUser } from '../../../../../../lib/auth/session';
import { prisma } from '../../../../../../lib/db';
import { toApiErrorResponse } from '../../../../../../lib/errors';
import { withRequestId } from '../../../../../../lib/log';
import { hashResearchRevision } from '../../../../../../lib/research-revision';
import {
  asReviewClaims,
  claimEvidenceStatus,
  claimIsFactual,
  getReviewPublicationGate,
  isReviewDecisionAction,
  reviewClaimId,
  reviewCoverageStatus,
  type ReviewDecisionAction,
} from '../../../../../../lib/research-review-decisions';
import { resolveCurrentReviewState } from '../../../../../../lib/research-review-state';
import { evaluateResearchSufficiency } from '../../../../../../lib/research-sufficiency';
import { ResearchBriefSchema } from '@deep-research/shared/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';

const IdParam = z.object({ id: z.string().uuid() });
const DecisionInput = z.object({
  runId: z.string().uuid().optional(),
  claimId: z.string().trim().min(1).max(160),
  action: z.string().trim().min(1).max(32),
  reason: z.string().trim().max(2_000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const researchSelect = {
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
      sourceSnapshotHash: true,
      policyVersion: true,
      executionStatus: true,
      outcome: true,
      attempt: true,
      startedAt: true,
      leaseExpiresAt: true,
      heartbeatAt: true,
      completedAt: true,
      summary: true,
      claims: true,
      details: true,
      triggeredBy: true,
      createdAt: true,
      decisions: {
        orderBy: { createdAt: 'asc' as const },
        select: {
          id: true,
          claimId: true,
          revisionHash: true,
          action: true,
          reason: true,
          metadata: true,
          actorId: true,
          createdAt: true,
        },
      },
    },
  },
} as const;

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
  const input = await parseBody(req, DecisionInput);
  if (input instanceof NextResponse) return input;
  if (!isReviewDecisionAction(input.action)) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '不支持的审核处理动作',
      requestId,
      details: { action: input.action },
    });
  }
  const action = input.action as ReviewDecisionAction;

  const research = await prisma.research.findUnique({
    where: { id: parsed.data.id },
    select: researchSelect,
  });
  if (
    !research
    || research.status !== 'draft'
    || (research.authorId !== user.id && user.role !== 'admin')
  ) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '草稿不存在',
      requestId,
    });
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
      details: { revisionHash, reviewStatus: state.status, runId: run?.id ?? null },
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
  const claim = claims.find((item) => reviewClaimId(item) === input.claimId);
  if (!claim) {
    return toApiErrorResponse({
      code: ERROR_CODES.NOT_FOUND,
      message: '审核声明不存在，可能已随新版本失效。',
      requestId,
    });
  }

  const evidenceStatus = claimEvidenceStatus(claim);
  const risk = claim.risk?.toLowerCase();
  const workflowAction = action === 'request_verification' || action === 'challenge_support';
  const reasonRequired = action === 'accept_uncertainty'
    || action === 'mark_not_fact'
    || action === 'challenge_support';
  if (reasonRequired && !input.reason?.trim()) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '请说明为什么这样处理这条声明。',
      requestId,
      details: { field: 'reason' },
    });
  }
  if (action === 'confirm_support' && evidenceStatus !== 'supported') {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '只有保存了可检查摘录的声明才能确认证据。',
      requestId,
    });
  }
  if (action === 'accept_uncertainty' && (!claimIsFactual(claim) || risk === 'high' || evidenceStatus !== 'unverified')) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '只有低/中风险且证据不足的事实声明可以接受为待验证项。',
      requestId,
    });
  }
  if (action === 'accept_conflict_risk') {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '来源冲突不能作为风险直接接受；请修改为明确的冲突/不确定表述，或删除声明后重新审核。',
      requestId,
    });
  }
  if (action === 'mark_not_fact' && (claimIsFactual(claim) || claimIsCitationRelationshipForDecision(claim))) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '不能在正文不变的情况下把事实声明改标为非事实；请先修改正文，再对当前版本重新审核。',
      requestId,
    });
  }
  if (action === 'request_verification' && (!claimIsFactual(claim) || evidenceStatus === 'supported')) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '只有仍缺少直接证据或存在冲突的事实声明需要补充核验。',
      requestId,
    });
  }
  if (action === 'challenge_support' && (!claimIsFactual(claim) || evidenceStatus !== 'supported')) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '只有已有可检查证据的事实声明可以发起证据质疑。',
      requestId,
    });
  }

  const result = await prisma.$transaction(async (tx) => {
    // Re-read the run inside the transaction. This prevents a decision from
    // being attached after an edit has already made the run stale.
    const freshResearch = await tx.research.findUnique({
      where: { id: research.id },
      select: {
        id: true,
        status: true,
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
      },
    });
    const freshRun = await tx.researchReviewRun.findUnique({
      where: { id: run.id },
      select: {
        id: true,
        revisionHash: true,
        executionStatus: true,
        outcome: true,
        summary: true,
        claims: true,
        decisions: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            claimId: true,
            revisionHash: true,
            action: true,
            reason: true,
            metadata: true,
            actorId: true,
            createdAt: true,
          },
        },
      },
    });
    if (
      !freshResearch
      || freshResearch.status !== 'draft'
      || !freshRun
      || freshRun.executionStatus !== 'completed'
      || freshRun.revisionHash !== hashResearchRevision(freshResearch)
      || freshRun.revisionHash !== revisionHash
    ) {
      throw new Error('REVIEW_DECISION_STALE');
    }
    // A verification request is a workflow command, not an author's
    // publication decision. Persist it on the replacement run's workflow
    // metadata below; putting it in the decision ledger made the UI imply
    // that a person had resolved the claim when in fact they only asked the
    // system to do more work.
    const decision = workflowAction
      ? null
      : await tx.researchReviewDecision.create({
          data: {
            researchReviewRunId: freshRun.id,
            claimId: input.claimId,
            revisionHash,
            action,
            reason: input.reason?.trim() || null,
            metadata: {
              ...(input.metadata ?? {}),
              machineVerdict: claim.verdict ?? null,
              machineRisk: claim.risk ?? null,
              evidenceStatus,
            },
            actorId: user.id,
          },
          select: {
            id: true,
            claimId: true,
            revisionHash: true,
            action: true,
            reason: true,
            metadata: true,
            actorId: true,
            createdAt: true,
          },
        });
    const decisions = decision ? [...freshRun.decisions, decision] : freshRun.decisions;
    const freshBrief = ResearchBriefSchema.safeParse(freshResearch.sourceAiJob?.brief);
    const freshResearchSufficiency = evaluateResearchSufficiency({
      brief: freshBrief.success ? freshBrief.data : null,
      sources: freshResearch.sourceAiJob?.aiResearchSources ?? [],
      sourcePolicy: freshResearch.sourceAiJob?.sourcePolicy
        ?? (freshBrief.success ? freshBrief.data.sourcePolicy : null),
    });
    const gate = getReviewPublicationGate({
      executionStatus: freshRun.executionStatus,
      outcome: freshRun.outcome,
      coverageStatus: reviewCoverageStatus(freshRun.summary),
      researchSufficiencyStatus: freshResearchSufficiency.status,
      claims: freshRun.claims,
      decisions,
    });
    let queuedReview: {
      id: string;
      executionStatus: 'queued';
      outcome: null;
      revisionHash: string;
      sourceSnapshotHash: string;
      policyVersion: string;
      attempt: number;
      triggeredBy: string;
      createdAt: Date;
    } | null = null;
    if (workflowAction) {
      // Re-verification is part of the same transaction as the request
      // record. A UI retry must never leave behind a request that looks
      // actionable while no worker can pick it up.
      const queuedAt = new Date();
      const queuedId = randomUUID();
      const sourceSnapshotHash = hashSourceSnapshot(freshResearch.researchSources);
      const queuedDetails = {
        phase: 'queued',
        status: 'queued',
        attempts: 0,
        runId: queuedId,
        revisionHash,
        sourceSnapshotHash,
        triggeredBy: action === 'challenge_support' ? 'evidence_challenge' : 'claim_verification',
        requestedClaimIds: [input.claimId],
        requestedFromRunId: freshRun.id,
        reviewMode: action === 'challenge_support' ? 'evidence_challenge' : 'claim_verification',
        targetClaim: action === 'challenge_support'
          ? {
              claim_id: reviewClaimId(claim),
              claim: claim.claim ?? '',
              claim_type: claim.claim_type ?? 'external_fact',
              risk: claim.risk ?? 'medium',
              verdict: claim.verdict ?? null,
              judgment_status: claim.judgment_status ?? 'settled',
              evidence: claim.evidence ?? null,
              location: claim.location ?? null,
            }
          : null,
        workflowEvent: {
          type: action === 'challenge_support'
            ? 'challenge_machine_support'
            : 'reverify_current_evidence',
          claimId: input.claimId,
          requestedBy: user.id,
          reason: input.reason?.trim() || null,
        },
        queuedAt: queuedAt.toISOString(),
      };
      await tx.researchReviewRun.create({
        data: {
          id: queuedId,
          researchId: freshResearch.id,
          aiResearchJobId: freshResearch.sourceAiJob?.id ?? null,
          revisionHash,
          sourceSnapshotHash,
          policyVersion: 'fact-review-v1',
          executionStatus: 'queued',
          outcome: null,
          attempt: 0,
        details: queuedDetails as Prisma.InputJsonValue,
          triggeredBy: action === 'challenge_support' ? 'evidence_challenge' : 'claim_verification',
          createdAt: queuedAt,
        },
      });
      // A re-check creates a new immutable assessment snapshot. Carry forward
      // only explicit "accept as uncertainty" decisions from the previous
      // snapshot; they remain valid for unchanged claim ids, but the gate
      // will naturally stop resolving one if the new machine verdict becomes
      // a contradiction or the claim disappears. Without this handoff,
      // asking to verify one claim silently reopens every unrelated item.
      const inheritedDecisions = freshRun.decisions
        .filter((item) => item.action === 'accept_uncertainty' && item.revisionHash === revisionHash)
        .map((item) => ({
          researchReviewRunId: queuedId,
          claimId: item.claimId,
          revisionHash,
          action: item.action,
          reason: item.reason,
          metadata: {
            ...(
              item.metadata
              && typeof item.metadata === 'object'
              && !Array.isArray(item.metadata)
                ? item.metadata as Record<string, unknown>
                : {}
            ),
            inheritedFromRunId: freshRun.id,
          } as Prisma.InputJsonValue,
          actorId: item.actorId,
        }));
      if (inheritedDecisions.length > 0) {
        await tx.researchReviewDecision.createMany({ data: inheritedDecisions });
      }
      if (freshResearch.sourceAiJob?.id) {
        await tx.aiResearchJob.update({
          where: { id: freshResearch.sourceAiJob.id },
          data: {
            reviewStatus: 'queued',
            reviewAttempts: 0,
            reviewStartedAt: null,
            reviewRunToken: null,
            reviewSummary: Prisma.DbNull,
            reviewClaims: [],
            reviewedAt: null,
            reviewDetails: queuedDetails as Prisma.InputJsonValue,
          },
        });
      }
      queuedReview = {
        id: queuedId,
        executionStatus: 'queued',
        outcome: null,
        revisionHash,
        sourceSnapshotHash,
        policyVersion: 'fact-review-v1',
        attempt: 0,
        triggeredBy: action === 'challenge_support' ? 'evidence_challenge' : 'claim_verification',
        createdAt: queuedAt,
      };
    }
    // Keep the old row-level mirror useful for the publish CAS while the
    // run/decision tables remain the authoritative source of truth.
    await tx.research.update({
      where: { id: freshResearch.id },
      data: {
        reviewStatus: workflowAction
          ? 'queued'
          : gate.status === 'clear' || gate.status === 'publish_with_disclosure'
          ? 'passed'
          : gate.status === 'blocked'
            ? 'blocked'
            : gate.status === 'needs_action'
              || gate.status === 'coverage_insufficient'
              || gate.status === 'research_insufficient'
              ? 'needs_action'
              : 'needs_revision',
        ...(workflowAction
          ? {
              reviewAttempts: 0,
              reviewStartedAt: null,
              reviewRunToken: null,
              reviewSummary: Prisma.DbNull,
              reviewClaims: [],
              reviewedAt: null,
              reviewDetails: {
                phase: 'queued',
                status: 'queued',
                runId: queuedReview?.id ?? null,
              } as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    return { decision, gate, queuedReview };
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'REVIEW_DECISION_STALE') return null;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return 'REVIEW_ALREADY_RUNNING' as const;
    }
    throw error;
  });

  if (result === 'REVIEW_ALREADY_RUNNING') {
    return NextResponse.json(
      {
        code: ERROR_CODES.AI_REVIEW_CONFLICT,
        message: '补充核验已在排队，请等待当前审核结束。',
        requestId,
      },
      { status: 409 },
    );
  }
  if (!result) {
    return NextResponse.json(
      {
        code: ERROR_CODES.AI_REVIEW_CONFLICT,
        message: '研究内容或审核结果已发生变化，请刷新后重新处理。',
        requestId,
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    runId: run.id,
    revisionHash,
    decision: result.decision
      ? {
          ...result.decision,
          createdAt: result.decision.createdAt.toISOString(),
        }
      : null,
    publicationGate: result.gate,
    queuedReview: result.queuedReview
      ? { ...result.queuedReview, createdAt: result.queuedReview.createdAt.toISOString() }
      : null,
  });
});

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashSourceSnapshot(sources: Array<{
  sourceRef: unknown;
  canonicalKey: string;
  title: string | null;
  description: string | null;
}>): string {
  const payload = sources
    .map((source) => ({
      canonicalKey: source.canonicalKey,
      sourceRef: source.sourceRef,
      title: source.title,
      snippet: source.description,
    }))
    .sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));
  return hashText(JSON.stringify(payload));
}

function claimIsCitationRelationshipForDecision(claim: { evidence?: { resolver?: string | null } | null }): boolean {
  return claim.evidence?.resolver === 'captured-source-citation';
}
