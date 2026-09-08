// GET /api/researches/[id]/evidence-tasks/[taskId]
// Polling this endpoint also performs the durable handoff from retrieval to a
// new review run. That makes the transition idempotent and recoverable even if
// the browser is closed after the evidence job finishes.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler } from '../../../../../../lib/api-handler';
import { requireUser } from '../../../../../../lib/auth/session';
import { prisma } from '../../../../../../lib/db';
import { toApiErrorResponse } from '../../../../../../lib/errors';
import { withRequestId } from '../../../../../../lib/log';
import { reconcileResearchEvidenceTask } from '../../../../../../lib/research-evidence-task';
import { ERROR_CODES } from '@deep-research/shared/errors';

const Params = z.object({ id: z.string().uuid(), taskId: z.string().uuid() });

export const GET = apiHandler<[NextRequest, { params: Promise<{ id: string; taskId: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '参数必须为 UUID', requestId });
  }

  const taskOwner = await prisma.researchEvidenceTask.findUnique({
    where: { id: parsed.data.taskId },
    select: { researchId: true, research: { select: { authorId: true } } },
  });
  if (
    !taskOwner
    || taskOwner.researchId !== parsed.data.id
    || (taskOwner.research.authorId !== user.id && user.role !== 'admin')
  ) {
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: '补证任务不存在', requestId });
  }

  const reconciled = await reconcileResearchEvidenceTask(parsed.data.taskId);
  if (!reconciled) {
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: '补证任务不存在', requestId });
  }
  const reviewRun = reconciled.reviewRunId
    ? await prisma.researchReviewRun.findUnique({
        where: { id: reconciled.reviewRunId },
        select: {
          id: true,
          executionStatus: true,
          outcome: true,
          revisionHash: true,
          sourceSnapshotHash: true,
          createdAt: true,
          completedAt: true,
        },
      })
    : null;

  return NextResponse.json({
    task: reconciled.task,
    reviewRun: reviewRun
      ? { ...reviewRun, createdAt: reviewRun.createdAt.toISOString(), completedAt: reviewRun.completedAt?.toISOString() ?? null }
      : null,
  });
});

