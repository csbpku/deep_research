// BFF handler: POST /api/researches/[id]/publish — 发布草稿。
//
// 契约源：
//   - docs/contracts/state-machines.md §5: draft → published
//   - 验收: owner/admin 可发布；已发布报 409；审计失败时事务回滚
//
// 行为：校验 owner + draft 状态 → 写 publish audit + 更新 status

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../../lib/db';
import { apiHandler } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { log, withRequestId } from '../../../../../lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { RESEARCH_STATUS } from '@deep-research/shared/states';
import { queuePersonalKnowledgeIndex } from '../../../../../lib/personal-knowledge-index';
import { resolveCurrentReviewState } from '../../../../../lib/research-review-state';
import {
  getReviewPublicationGate,
  getReviewPublishDisposition,
  reviewCoverageStatus,
} from '../../../../../lib/research-review-decisions';
import { evaluateResearchSufficiency } from '../../../../../lib/research-sufficiency';
import { researchPublicationVersion } from '../../../../../lib/research-publication-version';
import { projectResearchReviewForReader } from '../../../../../lib/research-review-reader';
import { ResearchBriefSchema } from '@deep-research/shared/schemas';

const IdParam = z.object({ id: z.string().uuid() });
const PublishBody = z.object({
  // A team publish with residual uncertainty is allowed only when the author
  // explicitly acknowledges it. The flag is an action, not a hidden default.
  acknowledgeDisclosure: z.boolean().optional(),
  publicationVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

const publicationSelect = {
  id: true,
  type: true,
  authorId: true,
  knowledgeIndexText: true,
  status: true,
  title: true,
  body: true,
  background: true,
  conclusion: true,
  risks: true,
  tags: true,
  creationMethod: true,
  reviewStatus: true,
  updatedAt: true,
  sourceAiJob: {
    select: {
      brief: true,
      sourcePolicy: true,
      aiResearchSources: {
        orderBy: { createdAt: 'asc' },
        select: { canonicalKey: true, title: true, snippet: true },
      },
    },
  },
  reviewRuns: {
    orderBy: { createdAt: 'desc' },
    // Keep exact-revision history: retries cannot erase known conflicts.
    select: {
      id: true,
      revisionHash: true,
      executionStatus: true,
      outcome: true,
      attempt: true,
      createdAt: true,
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
  },
} as const;
type PublicationResearch = Prisma.ResearchGetPayload<{ select: typeof publicationSelect }>;

function publicationReview(existing: PublicationResearch) {
  const reviewState = resolveCurrentReviewState(
    existing,
    existing.reviewRuns,
    existing.reviewStatus,
  );
  const parsedBrief = ResearchBriefSchema.safeParse(existing.sourceAiJob?.brief);
  const researchSufficiency = evaluateResearchSufficiency({
    brief: parsedBrief.success ? parsedBrief.data : null,
    sources: existing.sourceAiJob?.aiResearchSources ?? [],
    reportContent: existing.body,
    sourcePolicy: existing.sourceAiJob?.sourcePolicy
      ?? (parsedBrief.success ? parsedBrief.data.sourcePolicy : null),
  });
  const publicationGate = reviewState.run
    ? getReviewPublicationGate({
        executionStatus: reviewState.run.executionStatus,
        outcome: reviewState.run.outcome,
        coverageStatus: reviewCoverageStatus(reviewState.run.summary),
        researchSufficiencyStatus: researchSufficiency.status,
        claims: reviewState.run.claims,
        decisions: reviewState.run.decisions,
      })
    : reviewState.isLegacyFallback && reviewState.status === 'passed'
      ? {
          status: 'clear' as const,
          coverageStatus: 'complete' as const,
          coverageIncomplete: false,
          researchSufficiencyStatus: researchSufficiency.status,
          openCount: 0,
          highRiskOpenCount: 0,
          conflictCount: 0,
          acceptedCount: 0,
          unsupportedCount: 0,
          disclosedCount: 0,
          hardBlockCount: 0,
        }
      : null;
  const disposition = getReviewPublishDisposition(publicationGate, {
    claims: reviewState.run?.claims,
    decisions: reviewState.run?.decisions,
  });
  const reader = projectResearchReviewForReader({
    status: 'published', creationMethod: existing.creationMethod,
    currentReview: reviewState, reviewRuns: existing.reviewRuns,
    researchSufficiencyStatus: researchSufficiency.status,
  });
  return {
    reviewState, publicationGate, researchSufficiency,
    disposition: { ...disposition, hardBlocked: disposition.hardBlocked || reader.reviewVerification === 'conflicted' },
    version: researchPublicationVersion(existing, researchSufficiency.status),
  };
}

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const body = PublishBody.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '发布参数无效', requestId, details: body.error.flatten() });
  }
  const acknowledgeDisclosure = body.data.acknowledgeDisclosure === true;

  const parsed = IdParam.safeParse(await ctx.params);
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
    select: publicationSelect,
  });

  if (!existing) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '调研库不存在',
      requestId,
    });
  }

  // owner / admin 可发布；发布动作统一经过摘要与事实审核门禁。
  if (existing.authorId !== u.id && u.role !== 'admin') {
    return toApiErrorResponse({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: '没有权限发布这份调研',
      requestId,
    });
  }

  if (existing.status === RESEARCH_STATUS.PUBLISHED) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_ALREADY_PUBLISHED,
      message: '已发布，不能重复发布',
      requestId,
    });
  }

  if (existing.status !== RESEARCH_STATUS.DRAFT) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_ALREADY_PUBLISHED,
      message: '只能发布草稿状态的内容',
      requestId,
    });
  }

  // AI-generated research is a public knowledge asset, not just a private
  // model response. A verdict is valid only for the exact current snapshot.
  // The resolver intentionally ignores legacy mirrors once the new relation
  // has been loaded, so a historical passed/blocked result cannot leak across
  // an edit or a revert.
  const { reviewState, publicationGate, disposition, version } = publicationReview(existing);
  if (existing.creationMethod === 'ai_research' && (
    (acknowledgeDisclosure && !body.data.publicationVersion)
    || (body.data.publicationVersion && body.data.publicationVersion !== version)
  )) {
    return NextResponse.json({
      code: ERROR_CODES.AI_REVIEW_CONFLICT,
      message: '发布确认对应的研究或审核版本已变化；请刷新并重新确认披露。', requestId,
    }, { status: 409 });
  }
  if (disposition.hardBlocked || reviewState.status === 'blocked') {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '事实审核发现高风险冲突；修订相关结论并重新审核后才能发布',
      requestId,
      details: { publicationGate, disclosure: disposition.disclosure },
    });
  }
  if (
    existing.creationMethod === 'ai_research'
    && (disposition.requiresAcknowledgement || !publicationGate)
    && !acknowledgeDisclosure
  ) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '这份调研还有未完成核验的内容；确认带披露发布后才能继续',
      requestId,
      details: {
        reviewStatus: reviewState.status,
        reviewRunId: reviewState.run?.id ?? null,
        reviewRunStatus: reviewState.run?.executionStatus ?? 'not_started',
        reviewRunOutcome: reviewState.outcome,
        reviewRevisionMatches: reviewState.isCurrentRevision,
        publicationGate,
        requiresDisclosureAcknowledgement: true,
        disclosure: disposition.disclosure,
      },
    });
  }

  // Knowledge cards are a pointer plus a short judgment, not a research
  // report: background/risk sections are optional, so their own gate only
  // requires a non-empty body.
  const isKnowledgeCard = existing.type === 'knowledge';
  const missingSummaryFields = isKnowledgeCard
    ? (!existing.body.trim() ? ['正文'] : [])
    : [
      !existing.background?.trim() ? '背景' : null,
      !existing.conclusion?.trim() ? '结论' : null,
      !existing.risks?.trim() ? '风险或待验证项' : null,
    ].filter((field): field is string => Boolean(field));
  if (missingSummaryFields.length > 0) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: `发布前必须填写研究摘要：${missingSummaryFields.join('、')}`,
      requestId,
      details: { missing: missingSummaryFields },
    });
  }

  // AI-generated drafts may be published as-is after the author explicitly
  // confirms publication. The review status remains the safety gate for
  // factual conflicts; an artificial "must edit one field" requirement is
  // not part of the publishing contract.
  const aiAssisted = existing.creationMethod === 'ai_research';

  // $transaction: compare-and-set status/review + audit —— 审计失败时正文
  // 修改整体回滚。The initial read above is only for a friendly response;
  // the conditional update is the actual publication gate. Without it, an
  // edit that invalidates a passed review between the read and this write
  // could still publish an unreviewed revision.
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const publishedAt = new Date();
      const fresh = await tx.research.findUnique({ where: { id: parsed.data.id }, select: publicationSelect });
      if (!fresh || fresh.status !== RESEARCH_STATUS.DRAFT) throw new Error('RESEARCH_PUBLISH_CONFLICT');
      const freshReview = publicationReview(fresh);
      if (freshReview.version !== version) throw new Error('RESEARCH_PUBLISH_CONFLICT');
      if (aiAssisted && freshReview.disposition.hardBlocked) throw new Error('RESEARCH_PUBLISH_REVIEW_GATE');
      if (aiAssisted && (freshReview.disposition.requiresAcknowledgement || !freshReview.publicationGate) && !acknowledgeDisclosure) {
        throw new Error('RESEARCH_PUBLISH_DISCLOSURE_REQUIRED');
      }
      const claimed = await tx.research.updateMany({
        where: {
          id: parsed.data.id,
          status: RESEARCH_STATUS.DRAFT,
          // Exact snapshot CAS accepts acknowledged null/unavailable states,
          // while preserving the original row-race boundary.
          updatedAt: existing.updatedAt,
          reviewStatus: existing.reviewStatus,
          title: existing.title, body: existing.body,
          background: existing.background, conclusion: existing.conclusion, risks: existing.risks,
          tags: { equals: existing.tags },
        },
        data: {
          // A compare-and-set update also takes the row lock that protects
          // the following update until the transaction commits. Keep the
          // draft status unchanged here; the actual transition is below.
          status: RESEARCH_STATUS.DRAFT,
        },
      });
      if (claimed.count !== 1) {
        throw new Error('RESEARCH_PUBLISH_CONFLICT');
      }

      const published = await tx.research.update({
        where: { id: parsed.data.id },
        data: {
          status: RESEARCH_STATUS.PUBLISHED,
          publishedAt,
          aiAssisted,
        },
        select: {
          id: true,
          type: true,
          status: true,
          title: true,
          body: true,
          background: true,
          conclusion: true,
          risks: true,
          tags: true,
          authorId: true,
          creationMethod: true,
          aiAssisted: true,
          publishedAt: true,
          createdAt: true,
          updatedAt: true,
          author: { select: { id: true, name: true, email: true } },
        },
      });

      await tx.researchAudit.create({
        data: {
          researchId: parsed.data.id,
          editorId: u.id,
          action: 'publish',
        },
      });
      if (existing.type === 'knowledge' && existing.knowledgeIndexText) {
        await queuePersonalKnowledgeIndex(tx, {
          ownerId: existing.authorId,
          researchId: existing.id,
          operation: 'delete',
        });
      }

    // ADR 0010: 发布时回流专题。来源是 AiResearchJob.primaryTopicId。
    // 防御：测试 mock 没有 findFirst；上层 $transaction 已被 mock 时
    // 不应在测试里假设 AI 调研链路。
    let sourceTopicId: string | null = null;
    try {
      const aiResearchJob = (tx as { aiResearchJob?: { findFirst?: (args: unknown) => Promise<{ primaryTopicId: string | null } | null> } })
        .aiResearchJob;
      if (aiResearchJob?.findFirst) {
        const sourceJob = await aiResearchJob.findFirst({
          where: { draftResearchId: parsed.data.id },
          select: { primaryTopicId: true },
        });
        sourceTopicId = sourceJob?.primaryTopicId ?? null;
      }
    } catch {
      sourceTopicId = null;
    }
    if (sourceTopicId) {
      const researchTopic = (tx as { researchTopic?: { upsert?: (args: unknown) => Promise<unknown> } })
        .researchTopic;
      if (researchTopic?.upsert) {
        await researchTopic.upsert({
          where: {
            researchId_topicId: {
              researchId: parsed.data.id,
              topicId: sourceTopicId,
            },
          },
          create: {
            researchId: parsed.data.id,
            topicId: sourceTopicId,
            relationType: 'auto',
          },
          update: {},
        });
      }
    }

    // 写入 product_events（research_published 指标事件）
    await tx.productEvent.create({
      data: {
        userId: u.id,
        eventName: 'research_published',
        entityType: 'research',
        entityId: parsed.data.id,
        metadata: { creationMethod: published.creationMethod },
        dedupeKey: `research_published:${parsed.data.id}`,
      },
    });

      return published;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      return NextResponse.json({ code: ERROR_CODES.AI_REVIEW_CONFLICT, message: '研究或审核状态正在更新，请刷新后重新确认发布。', requestId }, { status: 409 });
    }
    if (error instanceof Error && error.message === 'RESEARCH_PUBLISH_DISCLOSURE_REQUIRED') {
      return NextResponse.json(
        { code: ERROR_CODES.AI_REVIEW_CONFLICT, message: '审核状态已更新；请重新确认本次带披露发布。', requestId },
        { status: 409 },
      );
    }
    if (error instanceof Error && (error.message === 'RESEARCH_PUBLISH_CONFLICT' || error.message === 'RESEARCH_PUBLISH_REVIEW_GATE')) {
      return NextResponse.json(
        { code: ERROR_CODES.AI_REVIEW_CONFLICT, message: '草稿或审核状态已发生变化，请刷新后重新确认发布。', requestId },
        { status: 409 },
      );
    }
    throw error;
  }

  log.info('research.publish', 'published', {
    requestId,
    userId: u.id,
    researchId: existing.id,
  });

  return NextResponse.json({
    id: result.id,
    type: result.type,
    status: result.status,
    title: result.title,
    body: result.body,
    background: result.background,
    conclusion: result.conclusion,
    risks: result.risks,
    tags: result.tags,
    authorId: result.authorId,
    creationMethod: result.creationMethod,
    aiAssisted: result.aiAssisted,
    publishedAt: result.publishedAt?.toISOString() ?? null,
    createdAt: result.createdAt.toISOString(),
    updatedAt: result.updatedAt.toISOString(),
    author: { id: result.author.id, name: result.author.name },
  });
});
