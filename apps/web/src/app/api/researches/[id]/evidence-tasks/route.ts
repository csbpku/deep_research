// POST /api/researches/[id]/evidence-tasks
// Create a durable, claim-scoped search for new evidence. This is deliberately
// different from POST /review: the latter rechecks the existing ledger only.

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { apiHandler, parseBody } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { prisma } from '../../../../../lib/db';
import { getWebEnv } from '../../../../../lib/env';
import { fetchAiEngine } from '../../../../../lib/ai-bff/fetch-ai-engine';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { withRequestId } from '../../../../../lib/log';
import { hashResearchRevision } from '../../../../../lib/research-revision';
import {
  asReviewClaims,
  claimEvidenceStatus,
  claimIsFactual,
  reviewClaimId,
  reviewCoverageStatus,
} from '../../../../../lib/research-review-decisions';
import { resolveCurrentReviewState } from '../../../../../lib/research-review-state';
import { ERROR_CODES } from '@deep-research/shared/errors';

const IdParam = z.object({ id: z.string().uuid() });
const Input = z.object({
  runId: z.string().uuid().optional(),
  claimId: z.string().trim().min(1).max(160),
  searchInstruction: z.string().trim().max(1_000).optional(),
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
  const input = await parseBody(req, Input);
  if (input instanceof NextResponse) return input;

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
      sourceAiJob: { select: { id: true } },
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
            select: { claimId: true, action: true, reason: true, createdAt: true },
          },
        },
      },
    },
  });
  if (
    !research
    || research.status !== 'draft'
    || (research.authorId !== user.id && user.role !== 'admin')
  ) {
    return toApiErrorResponse({ code: ERROR_CODES.DRAFT_NOT_FOUND, message: '草稿不存在', requestId });
  }
  if (research.creationMethod !== 'ai_research') {
    return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '只有 AI 调研草稿支持定向补证', requestId });
  }

  const revisionHash = hashResearchRevision(research);
  const state = resolveCurrentReviewState(research, research.reviewRuns, undefined);
  const run = state.run;
  if (!run || !state.isCurrentRevision || run.executionStatus !== 'completed') {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_REVIEW_CONFLICT,
      message: '当前版本还没有可用于定向补证的完整审核结果。',
      requestId,
      details: { revisionHash, runId: run?.id ?? null },
    });
  }
  if (input.runId && input.runId !== run.id) {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_REVIEW_CONFLICT,
      message: '审核结果已更新，请刷新后重新选择声明。',
      requestId,
    });
  }
  if (reviewCoverageStatus(run.summary) === 'insufficient') {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_REVIEW_CONFLICT,
      message: '本轮审核没有覆盖足够的正文，先重新审核当前版本，再针对声明补证。',
      requestId,
    });
  }
  const claim = asReviewClaims(run.claims).find((item) => reviewClaimId(item) === input.claimId);
  if (!claim || !claimIsFactual(claim)) {
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: '审核声明不存在或不需要事实补证。', requestId });
  }
  const evidenceStatus = claimEvidenceStatus(claim);
  if (evidenceStatus === 'supported') {
    return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '这条声明已经有可检查证据，无需定向补证。', requestId });
  }

  const activeTask = await prisma.researchEvidenceTask.findFirst({
    where: {
      researchId: research.id,
      claimId: input.claimId,
      revisionHash,
      status: { in: ['queued', 'researching', 'evidence_ready', 'review_queued'] },
    },
    select: { id: true, status: true, sourceCount: true, reviewRunId: true },
  });
  if (activeTask) {
    return NextResponse.json({
      code: ERROR_CODES.AI_REVIEW_CONFLICT,
      message: '这条声明的补证任务已经在进行中。',
      task: activeTask,
      requestId,
    }, { status: 409 });
  }

  const taskId = randomUUID();
  const jobId = randomUUID();
  const idempotencyKey = randomUUID();
  const searchInstruction = [
    '这是一个声明级补证任务，不要修改原研究稿，不要生成新的研究结论。',
    `目标声明：${claim.claim?.trim().slice(0, 1_200) ?? '未命名声明'}`,
    '只寻找能够直接支持、反驳或修正这条声明的新资料；优先一手来源和权威文档。',
    input.searchInstruction ? `用户补充检索方向：${input.searchInstruction}` : '',
    '对每个来源保存可打开的正文摘录；无法直接确认时明确标记证据不足。',
  ].filter(Boolean).join('\n');

  let task: {
    createdJob: { id: string };
    createdTask: {
      id: string;
      status: string;
      sourceCount: number;
      reviewRunId: string | null;
      claimId: string;
      revisionHash: string;
      createdAt: Date;
    };
  };
  try {
    task = await prisma.$transaction(async (tx) => {
      const createdJob = await tx.aiResearchJob.create({
        data: {
          id: jobId,
          requesterId: user.id,
          topic: `核查：${(claim.claim ?? research.title).trim().slice(0, 180)}`,
          context: searchInstruction.slice(0, 2_000),
          reportType: 'evidence_search',
          artifactType: 'markdown',
          sourcePolicy: 'prefer_user_sources',
          reportLength: 'standard',
          maxUrlsToScrape: 12,
          status: 'queued',
          sourceRefs: [],
          partialSources: [],
          failedSources: [],
          idempotencyKey,
          objective: 'investigate',
          conversation: [],
        },
        select: { id: true },
      });
      const createdTask = await tx.researchEvidenceTask.create({
        data: {
          id: taskId,
          researchId: research.id,
          aiResearchJobId: createdJob.id,
          claimId: input.claimId,
          revisionHash,
          claimText: (claim.claim ?? '').trim().slice(0, 20_000),
          searchInstruction,
          status: 'queued',
        },
        select: {
          id: true,
          status: true,
          sourceCount: true,
          reviewRunId: true,
          claimId: true,
          revisionHash: true,
          createdAt: true,
        },
      });
      return { createdJob, createdTask };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.researchEvidenceTask.findFirst({
        where: {
          researchId: research.id,
          claimId: input.claimId,
          revisionHash,
          status: { in: ['queued', 'researching', 'evidence_ready', 'review_queued'] },
        },
        select: { id: true, aiResearchJobId: true, claimId: true, status: true, sourceCount: true, reviewRunId: true, revisionHash: true, createdAt: true },
      });
      if (existing) {
        return NextResponse.json({
          ok: true,
          task: { ...existing, jobId: existing.aiResearchJobId, createdAt: existing.createdAt.toISOString() },
          deduplicated: true,
        }, { status: 202 });
      }
    }
    throw error;
  }

  const upstream = await fetchAiEngine<{ job_id?: string; status?: string }>({
    url: `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/jobs`,
    method: 'POST',
    expect: 202,
    retry: false,
    timeoutMs: 10_000,
    requestId,
    context: 'ai.bff.claim-evidence.submit',
    body: {
      job_id: jobId,
      requester_id: user.id,
      topic: `核查：${(claim.claim ?? research.title).trim().slice(0, 180)}`,
      context: searchInstruction.slice(0, 2_000),
      report_type: 'evidence_search',
      report_length: 'standard',
      max_urls_to_scrape: 12,
      source_policy: 'prefer_user_sources',
      idempotency_key: idempotencyKey,
      source_refs: [],
    },
  });
  if (!upstream.ok) {
    await prisma.$transaction([
      prisma.researchEvidenceTask.update({
        where: { id: taskId },
        data: { status: 'failed', errorCode: upstream.code, errorMessage: '补证任务未能启动，原研究稿没有改变。', completedAt: new Date() },
      }),
      prisma.aiResearchJob.update({
        where: { id: jobId },
        data: { status: 'failed', errorCode: upstream.code, errorMessage: upstream.message, completedAt: new Date() },
      }),
    ]);
    return toApiErrorResponse({ code: upstream.code, message: upstream.message, requestId: upstream.requestId, details: upstream.details });
  }

  return NextResponse.json({
    ok: true,
    task: {
      id: task.createdTask.id,
      jobId,
      claimId: task.createdTask.claimId,
      status: task.createdTask.status,
      sourceCount: task.createdTask.sourceCount,
      revisionHash: task.createdTask.revisionHash,
      createdAt: task.createdTask.createdAt.toISOString(),
    },
  }, { status: 202 });
});
