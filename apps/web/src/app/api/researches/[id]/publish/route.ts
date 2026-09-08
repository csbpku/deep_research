// BFF handler: POST /api/researches/[id]/publish — 发布草稿。
//
// 契约源：
//   - docs/contracts/state-machines.md §5: draft → published
//   - 验收: owner/admin 可发布；已发布报 409；审计失败时事务回滚
//
// 行为：校验 owner + draft 状态 → 写 publish audit + 更新 status

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../../../../lib/db';
import { apiHandler } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { log, withRequestId } from '../../../../../lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { RESEARCH_STATUS } from '@deep-research/shared/states';
import { resolveCurrentReviewState } from '../../../../../lib/research-review-state';
import { getReviewPublicationGate, reviewCoverageStatus } from '../../../../../lib/research-review-decisions';
import { evaluateResearchSufficiency } from '../../../../../lib/research-sufficiency';
import { ResearchBriefSchema } from '@deep-research/shared/schemas';

const IdParam = z.object({ id: z.string().uuid() });

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

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
    select: {
      id: true,
      authorId: true,
      status: true,
      title: true,
      body: true,
      background: true,
      conclusion: true,
      risks: true,
      tags: true,
      creationMethod: true,
      reviewStatus: true,
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
        // Keep enough history to find an exact revision even when a user
        // edits, reverts, and reviews the same draft several times. The
        // resolver below never treats a mismatched run as current.
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
    },
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
  const reviewState = resolveCurrentReviewState(
    existing,
    existing.reviewRuns,
    existing.reviewStatus,
  );
  const parsedBrief = ResearchBriefSchema.safeParse(existing.sourceAiJob?.brief);
  const researchSufficiency = evaluateResearchSufficiency({
    brief: parsedBrief.success ? parsedBrief.data : null,
    sources: existing.sourceAiJob?.aiResearchSources ?? [],
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
          openCount: 0,
          highRiskOpenCount: 0,
          conflictCount: 0,
          acceptedCount: 0,
          unsupportedCount: 0,
          disclosedCount: 0,
          hardBlockCount: 0,
        }
      : null;
  if (publicationGate?.status === 'blocked' || reviewState.status === 'blocked') {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '事实审核发现冲突，修订并重新审核后才能发布',
      requestId,
      details: { publicationGate },
    });
  }
  if (
    existing.creationMethod === 'ai_research'
    && (!publicationGate || !['clear', 'publish_with_disclosure'].includes(publicationGate.status))
  ) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: publicationGate?.status === 'needs_action'
        ? '还有未处理的审核声明；请修改正文或明确接受允许保留的不确定性后再发布'
        : publicationGate?.status === 'coverage_insufficient'
          ? '本轮审核覆盖不足，不能据此发布；请重新审核当前版本'
        : publicationGate?.status === 'unavailable'
          ? '自动审核尚未完成，请重试或转人工审核后再发布'
          : '事实审核尚未完成，审核通过后才能发布 AI 调研',
      requestId,
      details: {
        reviewStatus: reviewState.status,
        reviewRunId: reviewState.run?.id ?? null,
        reviewRunStatus: reviewState.run?.executionStatus ?? 'not_started',
        reviewRunOutcome: reviewState.outcome,
        reviewRevisionMatches: reviewState.isCurrentRevision,
        publicationGate,
      },
    });
  }

  const missingSummaryFields = [
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
      if (aiAssisted) {
        // Re-evaluate the exact gate inside the publication transaction. The
        // first read is only for a friendly response; a decision or edit may
        // have raced with the button click.
        const txResearch = tx.research as typeof tx.research & {
          findUnique?: (args: unknown) => Promise<{
            id: string;
            title: string;
            body: string;
            background: string | null;
            conclusion: string | null;
            risks: string | null;
            tags: string[];
            reviewStatus: string | null;
            sourceAiJob: {
              brief: unknown;
              sourcePolicy: string;
              aiResearchSources: Array<{
                canonicalKey: string;
                title: string | null;
                snippet: string | null;
              }>;
            } | null;
            reviewRuns: Array<{
              id: string;
              revisionHash: string;
              executionStatus: string;
              outcome: string | null;
              attempt: number;
              summary: unknown;
              claims: unknown;
              decisions: Array<{
                id: string;
                claimId: string;
                revisionHash: string;
                action: string;
                reason: string | null;
                metadata: unknown;
                actorId: string;
                createdAt: Date;
              }>;
            }>;
          } | null>;
        };
        if (txResearch.findUnique) {
          const fresh = await txResearch.findUnique({
            where: { id: parsed.data.id },
            select: {
              id: true,
              title: true,
              body: true,
              background: true,
              conclusion: true,
              risks: true,
              tags: true,
              reviewStatus: true,
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
            },
          });
          if (!fresh) throw new Error('RESEARCH_PUBLISH_CONFLICT');
          const freshState = resolveCurrentReviewState(fresh, fresh.reviewRuns, fresh.reviewStatus);
          const freshBrief = ResearchBriefSchema.safeParse(fresh.sourceAiJob?.brief);
          const freshResearchSufficiency = evaluateResearchSufficiency({
            brief: freshBrief.success ? freshBrief.data : null,
            sources: fresh.sourceAiJob?.aiResearchSources ?? [],
            sourcePolicy: fresh.sourceAiJob?.sourcePolicy
              ?? (freshBrief.success ? freshBrief.data.sourcePolicy : null),
          });
          const freshGate = freshState.run
            ? getReviewPublicationGate({
                executionStatus: freshState.run.executionStatus,
                outcome: freshState.run.outcome,
                coverageStatus: reviewCoverageStatus(freshState.run.summary),
                researchSufficiencyStatus: freshResearchSufficiency.status,
                claims: freshState.run.claims,
                decisions: freshState.run.decisions,
              })
            : freshState.isLegacyFallback && freshState.status === 'passed'
              ? { status: 'clear' as const }
              : null;
          if (!freshGate || !['clear', 'publish_with_disclosure'].includes(freshGate.status)) {
            throw new Error('RESEARCH_PUBLISH_REVIEW_GATE');
          }
        }
      }
      const claimed = await tx.research.updateMany({
        where: {
          id: parsed.data.id,
          status: RESEARCH_STATUS.DRAFT,
          ...(aiAssisted ? { reviewStatus: { in: ['passed', 'needs_action', 'needs_revision'] } } : {}),
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
    });
  } catch (error) {
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

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
