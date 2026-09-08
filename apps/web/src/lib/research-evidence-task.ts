import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

import { prisma } from './db';
import { hashResearchRevision } from './research-revision';

type SourceSnapshotRow = {
  sourceRef: unknown;
  canonicalKey: string;
  title: string | null;
  description: string | null;
};

export type ResearchEvidenceTaskView = {
  id: string;
  researchId: string;
  aiResearchJobId: string;
  claimId: string;
  claimText: string;
  status: string;
  sourceCount: number;
  reviewRunId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashResearchSourceSnapshot(sources: SourceSnapshotRow[]): string {
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

function asTaskView(task: {
  id: string;
  researchId: string;
  aiResearchJobId: string;
  claimId: string;
  claimText: string;
  status: string;
  sourceCount: number;
  reviewRunId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}): ResearchEvidenceTaskView {
  return {
    id: task.id,
    researchId: task.researchId,
    aiResearchJobId: task.aiResearchJobId,
    claimId: task.claimId,
    claimText: task.claimText,
    status: task.status,
    sourceCount: task.sourceCount,
    reviewRunId: task.reviewRunId,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
  };
}

const taskViewSelect = {
  id: true,
  researchId: true,
  aiResearchJobId: true,
  claimId: true,
  revisionHash: true,
  claimText: true,
  status: true,
  sourceCount: true,
  reviewRunId: true,
  errorCode: true,
  errorMessage: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
} as const;

/**
 * Reconcile one claim-scoped retrieval task at the Web boundary.
 *
 * The engine only owns retrieval. This function owns the product invariant:
 * new evidence is first merged into the research source ledger, then a new
 * version-scoped review run is queued. The report body is never changed here.
 */
export async function reconcileResearchEvidenceTask(
  taskId: string,
): Promise<{ task: ResearchEvidenceTaskView; reviewRunId: string | null } | null> {
  const current = await prisma.researchEvidenceTask.findUnique({
    where: { id: taskId },
    select: {
      ...taskViewSelect,
      aiJob: { select: { status: true, errorCode: true, errorMessage: true } },
      research: {
        select: {
          id: true,
          title: true,
          body: true,
          background: true,
          conclusion: true,
          risks: true,
          tags: true,
          status: true,
          sourceAiJob: { select: { id: true } },
          reviewRuns: {
            where: { executionStatus: 'completed' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              decisions: {
                orderBy: { createdAt: 'asc' },
                select: {
                  claimId: true,
                  revisionHash: true,
                  action: true,
                  reason: true,
                  metadata: true,
                  actorId: true,
                },
              },
            },
          },
        },
      },
      reviewRun: { select: { executionStatus: true, outcome: true } },
    },
  });
  if (!current) return null;

  if (
    current.reviewRunId
    && current.reviewRun
    && ['completed', 'unavailable', 'stale'].includes(current.reviewRun.executionStatus)
    && !['completed', 'failed', 'stale'].includes(current.status)
  ) {
    const completed = await prisma.researchEvidenceTask.update({
      where: { id: taskId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        ...(current.reviewRun.executionStatus === 'unavailable'
          ? {
              errorCode: 'REVIEW_UNAVAILABLE',
              errorMessage: '新证据已合并，但这轮事实审核没有完成；原研究稿没有被自动改写。',
            }
          : {}),
      },
      select: taskViewSelect,
    });
    return { task: asTaskView(completed), reviewRunId: completed.reviewRunId };
  }

  if (current.status === 'queued' && current.aiJob.status === 'running') {
    await prisma.researchEvidenceTask.updateMany({
      where: { id: taskId, status: 'queued' },
      data: { status: 'researching', startedAt: new Date() },
    });
  }

  const terminal = ['succeeded', 'partial', 'failed', 'cancelled'].includes(current.aiJob.status);
  if (!terminal) {
    const view = await prisma.researchEvidenceTask.findUnique({ where: { id: taskId }, select: taskViewSelect });
    return view ? { task: asTaskView(view), reviewRunId: view.reviewRunId } : null;
  }

  if (current.aiJob.status === 'failed' || current.aiJob.status === 'cancelled') {
    const failed = await prisma.researchEvidenceTask.update({
      where: { id: taskId },
      data: {
        status: 'failed',
        errorCode: current.aiJob.errorCode ?? 'EVIDENCE_SEARCH_FAILED',
        errorMessage: current.aiJob.errorMessage ?? '定向补证任务未完成，原研究稿没有改变。',
        completedAt: new Date(),
      },
      select: taskViewSelect,
    });
    return { task: asTaskView(failed), reviewRunId: failed.reviewRunId };
  }

  const currentRevisionHash = hashResearchRevision(current.research);
  if (currentRevisionHash !== current.revisionHash || current.research.status !== 'draft') {
    const stale = await prisma.researchEvidenceTask.update({
      where: { id: taskId },
      data: {
        status: 'stale',
        errorCode: 'RESEARCH_REVISION_CHANGED',
        errorMessage: '研究正文已变化，本次补证不能自动合并；请对当前版本重新审核。',
        completedAt: new Date(),
      },
      select: taskViewSelect,
    });
    return { task: asTaskView(stale), reviewRunId: stale.reviewRunId };
  }

  const capturedSources = await prisma.aiResearchSource.findMany({
    where: {
      jobId: current.aiResearchJobId,
      snippet: { not: null },
    },
    orderBy: { createdAt: 'asc' },
    select: { sourceRef: true, canonicalKey: true, title: true, snippet: true },
  });
  const usableSources = capturedSources.filter((source) => Boolean(source.snippet?.trim()));
  if (usableSources.length === 0) {
    const failed = await prisma.researchEvidenceTask.update({
      where: { id: taskId },
      data: {
        status: 'failed',
        errorCode: 'NO_EVIDENCE_FOUND',
        errorMessage: '没有找到可核对的新来源，原研究稿没有改变。',
        completedAt: new Date(),
      },
      select: taskViewSelect,
    });
    return { task: asTaskView(failed), reviewRunId: failed.reviewRunId };
  }

  const result = await prisma.$transaction(async (tx) => {
    const fresh = await tx.researchEvidenceTask.findUnique({
      where: { id: taskId },
      select: {
        ...taskViewSelect,
        research: {
          select: {
            id: true,
            title: true,
            body: true,
            background: true,
            conclusion: true,
            risks: true,
            tags: true,
            status: true,
            sourceAiJob: { select: { id: true } },
            reviewRuns: {
              where: { executionStatus: 'completed' },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: {
                id: true,
                decisions: {
                  orderBy: { createdAt: 'asc' },
                  select: {
                    claimId: true,
                    revisionHash: true,
                    action: true,
                    reason: true,
                    metadata: true,
                    actorId: true,
                  },
                },
              },
            },
          },
        },
        reviewRun: { select: { executionStatus: true, outcome: true } },
      },
    });
    if (!fresh) return null;
    if (fresh.reviewRunId || ['completed', 'failed', 'stale'].includes(fresh.status)) {
      return { task: asTaskView(fresh), reviewRunId: fresh.reviewRunId };
    }
    if (
      fresh.research.status !== 'draft'
      || hashResearchRevision(fresh.research) !== fresh.revisionHash
    ) {
      const stale = await tx.researchEvidenceTask.update({
        where: { id: taskId },
        data: {
          status: 'stale',
          errorCode: 'RESEARCH_REVISION_CHANGED',
          errorMessage: '研究正文已变化，本次补证不能自动合并；请对当前版本重新审核。',
          completedAt: new Date(),
        },
        select: taskViewSelect,
      });
      return { task: asTaskView(stale), reviewRunId: null };
    }

    for (const source of usableSources) {
      await tx.researchSource.upsert({
        where: {
          researchId_canonicalKey: {
            researchId: fresh.researchId,
            canonicalKey: source.canonicalKey.slice(0, 512),
          },
        },
        create: {
          researchId: fresh.researchId,
          sourceRef: source.sourceRef as Prisma.InputJsonValue,
          canonicalKey: source.canonicalKey.slice(0, 512),
          title: source.title?.slice(0, 300) ?? null,
          description: source.snippet?.slice(0, 1000) ?? null,
        },
        update: {
          title: source.title?.slice(0, 300) ?? null,
          description: source.snippet?.slice(0, 1000) ?? null,
        },
      });
    }

    const sourceLedger = await tx.researchSource.findMany({
      where: { researchId: fresh.researchId },
      orderBy: { createdAt: 'asc' },
      select: { sourceRef: true, canonicalKey: true, title: true, description: true },
    });
    const sourceSnapshotHash = hashResearchSourceSnapshot(sourceLedger);
    const activeRun = await tx.researchReviewRun.findFirst({
      where: { researchId: fresh.researchId, executionStatus: { in: ['queued', 'reviewing'] } },
      select: { id: true },
    });
    if (activeRun) {
      const waiting = await tx.researchEvidenceTask.update({
        where: { id: taskId },
        data: {
          status: 'evidence_ready',
          sourceCount: usableSources.length,
          result: {
            sourceCount: usableSources.length,
            sourceSnapshotHash,
            waitingForReviewRunId: activeRun.id,
          } as Prisma.InputJsonValue,
        },
        select: taskViewSelect,
      });
      return { task: asTaskView(waiting), reviewRunId: null };
    }

    const queuedAt = new Date();
    const reviewRunId = randomUUID();
    const details = {
      phase: 'queued',
      status: 'queued',
      attempts: 0,
      runId: reviewRunId,
      revisionHash: fresh.revisionHash,
      sourceSnapshotHash,
      triggeredBy: 'claim_evidence',
      evidenceTaskId: taskId,
      requestedClaimIds: [fresh.claimId],
      queuedAt: queuedAt.toISOString(),
    };
    await tx.researchReviewRun.create({
      data: {
        id: reviewRunId,
        researchId: fresh.researchId,
        aiResearchJobId: fresh.research.sourceAiJob?.id ?? null,
        revisionHash: fresh.revisionHash,
        sourceSnapshotHash,
        policyVersion: 'fact-review-v1',
        executionStatus: 'queued',
        attempt: 0,
        details: details as Prisma.InputJsonValue,
        triggeredBy: 'claim_evidence',
        createdAt: queuedAt,
      },
    });
    const inheritedRun = fresh.research.reviewRuns?.find((item) => item.decisions.some((decision) => decision.revisionHash === fresh.revisionHash));
    const inheritedDecisions = inheritedRun?.decisions
      .filter((item) => item.action === 'accept_uncertainty' && item.revisionHash === fresh.revisionHash)
      .map((item) => ({
        researchReviewRunId: reviewRunId,
        claimId: item.claimId,
        revisionHash: fresh.revisionHash,
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
          inheritedFromRunId: inheritedRun?.id ?? null,
        } as Prisma.InputJsonValue,
        actorId: item.actorId,
      }));
    if (inheritedDecisions && inheritedDecisions.length > 0) {
      await tx.researchReviewDecision.createMany({ data: inheritedDecisions });
    }
    if (fresh.research.sourceAiJob?.id) {
      await tx.aiResearchJob.update({
        where: { id: fresh.research.sourceAiJob.id },
        data: {
          reviewStatus: 'queued',
          reviewAttempts: 0,
          reviewStartedAt: null,
          reviewRunToken: null,
          reviewSummary: Prisma.DbNull,
          reviewClaims: [],
          reviewedAt: null,
          reviewDetails: details as Prisma.InputJsonValue,
        },
      });
    }
    await tx.research.update({
      where: { id: fresh.researchId },
      data: {
        reviewStatus: 'queued',
        reviewAttempts: 0,
        reviewStartedAt: null,
        reviewRunToken: null,
        reviewSummary: Prisma.DbNull,
        reviewClaims: [],
        reviewedAt: null,
        reviewDetails: details as Prisma.InputJsonValue,
      },
    });
    const queued = await tx.researchEvidenceTask.update({
      where: { id: taskId },
      data: {
        status: 'review_queued',
        sourceCount: usableSources.length,
        reviewRunId,
        result: { sourceCount: usableSources.length, sourceSnapshotHash } as Prisma.InputJsonValue,
      },
      select: taskViewSelect,
    });
    return { task: asTaskView(queued), reviewRunId };
  });

  if (!result) return null;
  return result;
}
