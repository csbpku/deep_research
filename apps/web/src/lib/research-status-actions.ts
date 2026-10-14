// 调研库状态/精选变更的事务写入，供 owner 与 admin 路由共用。

import { RESEARCH_STATUS } from '@deep-research/shared/states';
import { ADMIN_TARGET_TYPE, writeAdminAction } from './radar/admin-actions';
import type { TxClient } from './radar/tx';
import { queuePersonalKnowledgeIndex } from './personal-knowledge-index';
import { resolveCurrentReviewState } from './research-review-state';
import { getReviewPublicationGate, reviewCoverageStatus } from './research-review-decisions';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { toApiErrorResponse } from './errors';

/**
 * Restoring an archived AI report returns it to published with no new review.
 * If the body was edited while archived, the old verdict no longer covers it,
 * so restore is refused until the current revision has a passing review.
 */
export class ResearchRestoreReviewRequiredError extends Error {
  constructor(readonly details: Record<string, unknown>) {
    super('AI_RESTORE_REVIEW_REQUIRED');
  }
}

export function restoreReviewRequiredResponse(
  error: ResearchRestoreReviewRequiredError,
  requestId: string,
) {
  return toApiErrorResponse({
    code: ERROR_CODES.AI_REVIEW_CONFLICT,
    message: '该 AI 调研在归档期间被修改，当前内容没有通过的事实审核；请先运行审核，或创建修订草稿审核后再发布。',
    requestId,
    details: error.details,
  });
}

export type ResearchStatusAction = 'archive' | 'restore';

export interface ResearchStatusTransitionOptions {
  id: string;
  actorId: string;
  action: ResearchStatusAction;
  adminAction?: {
    action: string;
    requestId: string;
  };
}

export async function transitionResearchStatus(
  tx: TxClient,
  options: ResearchStatusTransitionOptions,
): Promise<{
  id: string;
  status: string;
  updatedAt: Date;
  actionRequestId: string | null;
}> {
  const existing = await tx.research.findUnique({
    where: { id: options.id },
    select: {
      id: true,
      status: true,
      publishedAt: true,
      type: true,
      authorId: true,
      creationMethod: true,
      title: true,
      body: true,
      background: true,
      conclusion: true,
      risks: true,
      tags: true,
      reviewStatus: true,
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
  if (!existing) {
    throw new Error('RESEARCH_NOT_FOUND');
  }

  const isArchive = options.action === 'archive';
  if (isArchive && existing.status !== RESEARCH_STATUS.PUBLISHED) {
    throw new Error('INVALID_ARCHIVE_STATE');
  }
  if (!isArchive && existing.status !== RESEARCH_STATUS.ARCHIVED) {
    throw new Error('INVALID_RESTORE_STATE');
  }
  if (!isArchive && existing.creationMethod === 'ai_research') {
    const reviewState = resolveCurrentReviewState(
      existing,
      existing.reviewRuns ?? [],
      existing.reviewStatus,
    );
    const gate = reviewState.run && reviewState.isCurrentRevision
      ? getReviewPublicationGate({
          executionStatus: reviewState.run.executionStatus,
          outcome: reviewState.run.outcome,
          coverageStatus: reviewCoverageStatus(reviewState.run.summary),
          claims: reviewState.run.claims,
          decisions: reviewState.run.decisions,
        })
      : null;
    if (!gate || !['clear', 'publish_with_disclosure'].includes(gate.status)) {
      throw new ResearchRestoreReviewRequiredError({
        reviewStatus: reviewState.status,
        reviewRunId: reviewState.run?.id ?? null,
        reviewRevisionMatches: reviewState.isCurrentRevision,
        publicationGate: gate,
        createRevision: `/api/researches/${existing.id}/fork`,
      });
    }
  }

  const updated = await tx.research.update({
    where: { id: existing.id },
    data: isArchive
      ? { status: RESEARCH_STATUS.ARCHIVED }
      : {
          status: RESEARCH_STATUS.PUBLISHED,
          publishedAt: existing.publishedAt ?? new Date(),
        },
    select: { id: true, status: true, updatedAt: true },
  });

  if (isArchive && existing.type === 'knowledge') {
    await queuePersonalKnowledgeIndex(tx, {
      ownerId: existing.authorId,
      researchId: existing.id,
      operation: 'delete',
    });
  }

  await tx.researchAudit.create({
    data: {
      researchId: existing.id,
      editorId: options.actorId,
      action: options.action,
    },
  });

  let actionRequestId: string | null = null;
  if (options.adminAction) {
    actionRequestId = options.adminAction.requestId;
    await writeAdminAction(tx, {
      actorId: options.actorId,
      action: options.adminAction.action,
      targetType: ADMIN_TARGET_TYPE.RESEARCH,
      targetId: existing.id,
      requestId: actionRequestId,
      metadata: { previousStatus: existing.status },
    });
  }

  return { ...updated, actionRequestId };
}

export async function setResearchFeatured(
  tx: TxClient,
  options: {
    id: string;
    actorId: string;
    featured: boolean;
    adminAction?: {
      action: string;
      requestId: string;
    };
  },
): Promise<{
  id: string;
  featuredAt: Date | null;
  updatedAt: Date;
  actionRequestId: string | null;
}> {
  const existing = await tx.research.findUnique({
    where: { id: options.id },
    select: { id: true, status: true },
  });
  if (!existing) {
    throw new Error('RESEARCH_NOT_FOUND');
  }
  if (existing.status !== RESEARCH_STATUS.PUBLISHED) {
    throw new Error('INVALID_FEATURE_STATE');
  }

  const updated = await tx.research.update({
    where: { id: existing.id },
    data: { featuredAt: options.featured ? new Date() : null },
    select: { id: true, featuredAt: true, updatedAt: true },
  });

  await tx.researchAudit.create({
    data: {
      researchId: existing.id,
      editorId: options.actorId,
      action: options.featured ? 'feature' : 'unfeature',
    },
  });

  let actionRequestId: string | null = null;
  if (options.adminAction) {
    actionRequestId = options.adminAction.requestId;
    await writeAdminAction(tx, {
      actorId: options.actorId,
      action: options.adminAction.action,
      targetType: ADMIN_TARGET_TYPE.RESEARCH,
      targetId: existing.id,
      requestId: actionRequestId,
      metadata: { featured: options.featured },
    });
  }

  return { ...updated, actionRequestId };
}
