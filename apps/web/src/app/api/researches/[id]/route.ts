// BFF handler: GET    /api/researches/[id] — 详情
//               PUT    /api/researches/[id] — 编辑（含 published 修改审计）
//               DELETE /api/researches/[id] — owner 永久删除自己的 draft
//
// 契约源：
//   - docs/contracts/state-machines.md §5: ResearchStatus
//   - 验收: draft 仅 owner/admin 可见; published 全员可见
//   - 修改已发布内容 → $transaction 写 research_audit(diff)
//
// GET:  返回完整 research（含 audit history）
// PUT:  owner 可改自己的 draft；手工 published 内容沿用审计编辑；
//       已发布 AI 内容必须先 fork 为新 draft；任何失败整事务回滚

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  buildWeeklyProductEventDedupeKey,
  recordProductEvent,
} from '@/lib/product-events';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../lib/db';
import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { requireUser } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { log, withRequestId } from '../../../../lib/log';
import { UpdateResearchInput } from '../../../../lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { RESEARCH_STATUS } from '@deep-research/shared/states';
import { resolveResearchSourceLink } from '../../../../lib/research-source-link';
import { resolveCurrentReviewState } from '../../../../lib/research-review-state';
import { getReviewDisclosureItems, getReviewPublicationGate, reviewCoverageStatus } from '../../../../lib/research-review-decisions';
import { evaluateResearchSufficiency } from '../../../../lib/research-sufficiency';
import { ResearchBriefSchema } from '@deep-research/shared/schemas';

const IdParam = z.object({ id: z.string().uuid() });

const researchSelect = {
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
  originContentSha256: true,
  supersedesResearchId: true,
  reviewStatus: true,
  reviewAttempts: true,
  reviewSummary: true,
  reviewClaims: true,
  reviewStartedAt: true,
  reviewRunToken: true,
  reviewedAt: true,
  reviewDetails: true,
  sourceAiJob: {
    select: {
      brief: true,
      sourcePolicy: true,
      aiResearchSources: {
        orderBy: { createdAt: 'asc' },
        select: {
          canonicalKey: true,
          title: true,
          snippet: true,
        },
      },
    },
  },
  reviewRuns: {
    orderBy: { createdAt: 'desc' },
    take: 20,
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
  sourceCommentId: true,
  publishedAt: true,
  featuredAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true, email: true } },
  _count: { select: { comments: true } },
} as const;

// ─── GET /api/researches/[id] ─────────────────────────────────────────

export const GET = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
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

  const research = await prisma.research.findUnique({
    where: { id: parsed.data.id },
    select: researchSelect,
  });

  if (!research) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '调研库不存在',
      requestId,
    });
  }

  // 权限检查：published 全员可见；draft/archived 仅 owner 与 admin 可见。
  // Admin 可查看草稿与归档内容，但不能编辑他人草稿；非 owner 成员仍返回
  // 404，不泄露草稿存在性。
  if (research.status !== RESEARCH_STATUS.PUBLISHED && research.authorId !== u.id && u.role !== 'admin') {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '调研库不存在',
      requestId,
    });
  }

  // 服务端权限计算（避免前端硬编码 isOwner = true）：
  //   - canEdit：owner 可编辑自己的内容；admin 仅可编辑已发布内容
  //   - canManageStatus：owner 可归档/恢复自己的内容；admin 可管理
  //     published/archived，但不能管理他人的 draft
  const canEdit =
    research.authorId === u.id ||
    (u.role === 'admin' && research.status === RESEARCH_STATUS.PUBLISHED);
  const canManageStatus =
    research.authorId === u.id ||
    (u.role === 'admin' && research.status !== RESEARCH_STATUS.DRAFT);

  // 读取审计历史
    const audits = await prisma.researchAudit.findMany({
    where: { researchId: research.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      action: true,
      diff: true,
      prevSnapshot: true,
      sourceMessageId: true,
      sourceIntent: true,
      sourceQuestion: true,
      reason: true,
      sourceRefs: true,
      createdAt: true,
      editor: { select: { id: true, name: true, email: true } },
    },
  });

  // 研究报告和 AI 提炼的知识卡片都挂载可核对来源；sourceComment 仍保留
  // 给历史的评论晋级卡片使用。
  let researchSources: Array<{
    id: string;
    sourceRef: unknown;
    canonicalKey: string;
    title: string | null;
    description: string | null;
  }> = [];

  let sourceComment: {
    id: string;
    body: string;
    authorId: string;
    authorName: string;
    targetType: string;
    targetId: string | null;
    targetTitle: string | null;
  } | null = null;

  if (research.type === 'research' || research.type === 'knowledge') {
    const sources = await prisma.researchSource.findMany({
      where: { researchId: research.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        sourceRef: true,
        canonicalKey: true,
        title: true,
        description: true,
      },
    });
    researchSources = sources.filter((source) => {
      const ref = (source.sourceRef ?? {}) as { type?: string; value?: string };
      return resolveResearchSourceLink(ref, source.canonicalKey) !== null;
    });
  }

  if (research.sourceCommentId) {
    const sc = await prisma.comment.findUnique({
      where: { id: research.sourceCommentId },
      select: {
        id: true,
        body: true,
        authorId: true,
        targetType: true,
        summaryId: true,
        researchId: true,
        author: { select: { name: true } },
        summary: { select: { title: true } },
        research: { select: { title: true } },
      },
    });
    if (sc) {
      const targetTitle = sc.targetType === 'summary'
        ? sc.summary?.title ?? null
        : sc.research?.title ?? null;
      sourceComment = {
        id: sc.id,
        body: sc.body,
        authorId: sc.authorId,
        authorName: sc.author.name,
        targetType: sc.targetType,
        targetId: sc.summaryId ?? sc.researchId,
        targetTitle,
      };
    }
  }

  // V2 闭环埋点：草稿被 owner 打开 / 从专题页面重新进入
  if (research.status === RESEARCH_STATUS.DRAFT && research.authorId === u.id) {
    await recordProductEvent({
      userId: u.id,
      eventType: 'research_draft_opened',
      targetType: 'research',
      targetId: research.id,
      dedupeKey: buildWeeklyProductEventDedupeKey({
        userId: u.id,
        eventType: 'research_draft_opened',
        targetType: 'research',
        targetId: research.id,
      }),
      metadata: { authorRole: u.role },
    }).catch(() => undefined);
  }
  const fromTopic = new URL(req.url).searchParams.get('fromTopic');
  const referer = req.headers.get('referer') ?? '';
  if (
    !fromTopic &&
    !/\/topics\/[^/?#]+/.test(referer)
  ) {
    // no-op
  } else {
    await recordProductEvent({
      userId: u.id,
      eventType: 'research_reopened_from_topic',
      targetType: 'research',
      targetId: research.id,
      metadata: {
        fromTopicId: fromTopic,
        refererTopicSlug: (referer.match(/\/topics\/([^/?#]+)/) ?? [])[1] ?? null,
      },
    }).catch(() => undefined);
  }

  return NextResponse.json({
    ...shapeResearchDetail(research),
    canEdit,
    canManageStatus,
    researchSources: researchSources.map((s) => ({
      id: s.id,
      sourceRef: s.sourceRef,
      canonicalKey: s.canonicalKey,
      title: s.title,
      description: s.description,
    })),
    sourceComment,
    audits: audits.map((a) => ({
      id: a.id,
      action: a.action,
      diff: a.diff,
      prevSnapshot: a.prevSnapshot,
      sourceMessageId: a.sourceMessageId,
      sourceIntent: a.sourceIntent,
      sourceQuestion: a.sourceQuestion,
      reason: a.reason,
      sourceRefs: a.sourceRefs,
      createdAt: a.createdAt.toISOString(),
      editor: { id: a.editor.id, name: a.editor.name },
    })),
    commentCount: research._count.comments,
  });
});

// ─── PUT /api/researches/[id] ─────────────────────────────────────────

export const PUT = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  const saveMode = req.headers.get('x-save-mode') === 'auto' ? 'auto' : 'manual';
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

  const body = await parseBody(req, UpdateResearchInput);
  if (body instanceof NextResponse) return body;

  // 读取当前版本
  const existing = await prisma.research.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      title: true,
      body: true,
      background: true,
      conclusion: true,
      risks: true,
      tags: true,
      authorId: true,
      status: true,
      creationMethod: true,
      aiAssisted: true,
      sourceAiJob: {
        select: {
          id: true,
          brief: true,
          requesterId: true,
          aiResearchSources: {
            orderBy: { createdAt: 'asc' },
            select: { sourceRef: true, canonicalKey: true, title: true, snippet: true, createdAt: true },
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

  // owner 可编辑自己的草稿/已发布/已归档；admin 只能代编辑已发布内容
  if (
    existing.authorId !== u.id &&
    !(u.role === 'admin' && existing.status === RESEARCH_STATUS.PUBLISHED)
  ) {
    return toApiErrorResponse({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: '没有权限编辑这份调研',
      requestId,
    });
  }

  // A passed review belongs to this exact public snapshot. Mutating a
  // published AI report in place would make the old verdict appear to cover
  // new text, so callers must create a revision draft first.
  if (existing.status === RESEARCH_STATUS.PUBLISHED && existing.creationMethod === 'ai_research') {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_PUBLISHED_IMMUTABLE,
      message: '已发布的 AI 调研不可原地修改，请先创建修订草稿',
      requestId,
      details: { createRevision: `/api/researches/${existing.id}/fork` },
    });
  }

  const revisionAudit = body.revisionContext
    ? await resolveRevisionAuditContext({
        sourceMessageId: body.revisionContext.sourceMessageId,
        reason: body.revisionContext.reason,
        userId: u.id,
        aiJobId: existing.sourceAiJob?.id ?? null,
        sources: existing.sourceAiJob?.aiResearchSources ?? [],
        requestId,
      })
    : null;
  if (revisionAudit instanceof NextResponse) return revisionAudit;

  // 不允许 edited→published（发布必须走 publish endpoint）
  if (existing.status === RESEARCH_STATUS.PUBLISHED) {
    // 已发布的用 $transaction 包住 update + audit
    const prevSnapshot = {
      title: existing.title,
      body: existing.body,
      background: existing.background,
      conclusion: existing.conclusion,
      risks: existing.risks,
      tags: existing.tags,
    };

    const nextSnapshot = {
      title: body.title ?? existing.title,
      body: body.body ?? existing.body,
      background: body.background !== undefined ? body.background : existing.background,
      conclusion: body.conclusion !== undefined ? body.conclusion : existing.conclusion,
      risks: body.risks !== undefined ? body.risks : existing.risks,
      tags: body.tags ?? existing.tags,
    };

    const diff = computeDiff(prevSnapshot, nextSnapshot);

    // $transaction: update + audit 原子
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.research.update({
        where: { id: parsed.data.id },
        data: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
          background: body.background !== undefined ? body.background : undefined,
          conclusion: body.conclusion !== undefined ? body.conclusion : undefined,
          risks: body.risks !== undefined ? body.risks : undefined,
          ...(body.tags !== undefined ? { tags: body.tags } : {}),
        },
        select: researchSelect,
      });

      await tx.researchAudit.create({
        data: {
          researchId: parsed.data.id,
          editorId: u.id,
          action: 'edit',
          diff: diff as unknown as Prisma.InputJsonValue,
          prevSnapshot: prevSnapshot as unknown as Prisma.InputJsonValue,
          ...(revisionAudit ?? {}),
        },
      });

      return updated;
    });

    log.info('research.edit', 'published research updated with audit', {
      requestId,
      userId: u.id,
      researchId: existing.id,
    });

    return NextResponse.json({
      ...shapeResearchDetail(result),
      commentCount: result._count.comments,
    });
  }

  // draft 状态：自动保存不创建版本；显式保存保留可恢复快照。
  const prevSnapshot = {
    title: existing.title,
    body: existing.body,
    background: existing.background,
    conclusion: existing.conclusion,
    risks: existing.risks,
    tags: existing.tags,
  };
  const nextSnapshot = {
    title: body.title ?? existing.title,
    body: body.body ?? existing.body,
    background: body.background !== undefined ? body.background : existing.background,
    conclusion: body.conclusion !== undefined ? body.conclusion : existing.conclusion,
    risks: body.risks !== undefined ? body.risks : existing.risks,
    tags: body.tags ?? existing.tags,
  };
  const diff = computeDiff(prevSnapshot, nextSnapshot);
  const contentChanged = Object.keys(diff).length > 0;
  const invalidatedReview = contentChanged ? {
    reviewStatus: null,
    reviewAttempts: 0,
    reviewSummary: Prisma.DbNull,
    reviewClaims: [] as Prisma.InputJsonValue,
    reviewedAt: null,
    reviewStartedAt: null,
    reviewRunToken: null,
    reviewDetails: Prisma.DbNull,
  } : {};
  const updated = await prisma.$transaction(async (tx) => {
    if (contentChanged) {
      // The optional access keeps older transaction test doubles and staged
      // databases compatible while the new migration is rolled out.
      const reviewRuns = (tx as typeof tx & {
        researchReviewRun?: { updateMany: (args: unknown) => Promise<unknown> };
      }).researchReviewRun;
      if (reviewRuns) {
        await reviewRuns.updateMany({
          where: {
            researchId: parsed.data.id,
            executionStatus: { in: ['queued', 'reviewing'] },
          },
          data: {
            executionStatus: 'stale',
            outcome: 'stale',
            completedAt: new Date(),
          },
        });
      }
    }
    if (contentChanged && existing.sourceAiJob?.id) {
      // Keep the same lock order as review claim/complete (job first, then
      // research). Clearing both the status and token is the cancellation
      // boundary for an in-flight reviewer; a late result must be a no-op.
      const aiResearchJob = (tx as {
        aiResearchJob?: {
          update?: (args: unknown) => Promise<unknown>;
        };
      }).aiResearchJob;
      if (aiResearchJob?.update) {
        await aiResearchJob.update({
          where: { id: existing.sourceAiJob.id },
          data: {
            reviewStatus: null,
            reviewAttempts: 0,
            reviewSummary: Prisma.DbNull,
            reviewClaims: [] as Prisma.InputJsonValue,
            reviewedAt: null,
            reviewStartedAt: null,
            reviewRunToken: null,
            reviewDetails: Prisma.DbNull,
          },
        });
      }
    }
    const next = await tx.research.update({
      // The publish endpoint transitions the same row under a draft/status
      // compare-and-set.  Keeping this predicate here prevents an edit that
      // started before publish from writing back onto an already-published
      // AI snapshot after its initial read became stale.
      where: { id: parsed.data.id, status: RESEARCH_STATUS.DRAFT },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
        background: body.background !== undefined ? body.background : undefined,
        conclusion: body.conclusion !== undefined ? body.conclusion : undefined,
        risks: body.risks !== undefined ? body.risks : undefined,
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        // A review is valid only for the exact document snapshot it saw.
        // Any draft edit invalidates the old verdict before the new version
        // can be published or reviewed again.
        ...invalidatedReview,
      },
      select: researchSelect,
    });
    if (saveMode === 'manual' && Object.keys(diff).length > 0) {
        await tx.researchAudit.create({
          data: {
            researchId: parsed.data.id,
            editorId: u.id,
            action: 'edit',
            diff: diff as unknown as Prisma.InputJsonValue,
            prevSnapshot: prevSnapshot as unknown as Prisma.InputJsonValue,
            ...(revisionAudit ?? {}),
          },
        });
    }
    return next;
  }).catch((error: unknown) => {
    // A publish that won the row race changes status from draft to published;
    // the stale editor must refresh instead of receiving a false save success.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return null;
    }
    throw error;
  });
  if (updated === null) {
    return NextResponse.json(
      { code: ERROR_CODES.AI_REVIEW_CONFLICT, message: '研究版本已发生变化，请刷新后再保存。', requestId },
      { status: 409 },
    );
  }

  log.info('research.edit', 'draft updated', {
    requestId,
    userId: u.id,
    researchId: existing.id,
  });

  return NextResponse.json({
    ...shapeResearchDetail(updated),
    commentCount: updated._count.comments,
  });
});

// ─── POST /api/researches/[id]/versions/[versionId]/restore ─────────


// ─── DELETE /api/researches/[id] ──────────────────────────────────────

export const DELETE = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
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
      sourceAiJob: { select: { id: true } },
    },
  });

  if (!existing) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '草稿不存在',
      requestId,
    });
  }
  if (existing.authorId !== u.id) {
    if (u.role === 'admin') {
      return toApiErrorResponse({
        code: ERROR_CODES.PERMISSION_DENIED,
        message: 'admin 不能删除他人的草稿',
        requestId,
      });
    }
    return toApiErrorResponse({
      // Do not reveal that another user's private draft exists.
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '草稿不存在',
      requestId,
    });
  }
  if (existing.status !== RESEARCH_STATUS.DRAFT) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_ALREADY_PUBLISHED,
      message: '只有草稿可以永久删除',
      requestId,
    });
  }

  await prisma.$transaction(async (tx) => {
    if (existing.sourceAiJob?.id) {
      await tx.aiResearchJob.delete({
        where: { id: existing.sourceAiJob.id },
      });
    }
    await tx.research.delete({ where: { id: existing.id } });
  });

  log.info('research.delete', 'draft permanently deleted', {
    requestId,
    userId: u.id,
    researchId: existing.id,
    linkedAiJobId: existing.sourceAiJob?.id ?? null,
  });

  return NextResponse.json({ ok: true, id: existing.id });
});

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function shapeResearchDetail(r: {
  id: string;
  type: string;
  status: string;
  title: string;
  body: string;
  background: string | null;
  conclusion: string | null;
  risks: string | null;
  tags: string[];
  authorId: string;
  creationMethod: string;
  aiAssisted: boolean;
  originContentSha256: string | null;
  supersedesResearchId: string | null;
  reviewStatus: string | null;
  reviewAttempts: number;
  reviewSummary: unknown;
  reviewClaims: unknown;
  reviewStartedAt?: Date | null;
  reviewRunToken?: string | null;
  reviewedAt: Date | null;
  reviewDetails: unknown;
  sourceAiJob?: {
    brief: unknown;
    sourcePolicy: string;
    aiResearchSources: Array<{
      canonicalKey: string;
      title: string | null;
      snippet: string | null;
    }>;
  } | null;
  reviewRuns?: Array<{
    id: string;
    revisionHash: string;
    sourceSnapshotHash: string;
    policyVersion: string;
    executionStatus: string;
    outcome: string | null;
    attempt: number;
    startedAt: Date | null;
    leaseExpiresAt?: Date | null;
    heartbeatAt?: Date | null;
    completedAt: Date | null;
    summary: unknown;
    claims: unknown;
    details: unknown;
    triggeredBy: string;
    decisions?: Array<{
      id: string;
      claimId: string;
      revisionHash: string;
      action: string;
      reason: string | null;
      metadata: unknown;
      actorId: string;
      createdAt: Date;
    }>;
    createdAt: Date;
  }>;
  publishedAt: Date | null;
  featuredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  author: { id: string; name: string; email: string };
}) {
  const currentReview = resolveCurrentReviewState(r, r.reviewRuns, r.reviewStatus);
  const currentRevisionHash = currentReview.revisionHash;
  const parsedBrief = ResearchBriefSchema.safeParse(r.sourceAiJob?.brief);
  const researchSufficiency = evaluateResearchSufficiency({
    brief: parsedBrief.success ? parsedBrief.data : null,
    sources: r.sourceAiJob?.aiResearchSources ?? [],
    sourcePolicy: r.sourceAiJob?.sourcePolicy
      ?? (parsedBrief.success ? parsedBrief.data.sourcePolicy : null),
  });
  const currentReviewPublicationGate = currentReview.run
    ? getReviewPublicationGate({
        executionStatus: currentReview.run.executionStatus,
        outcome: currentReview.run.outcome,
        coverageStatus: reviewCoverageStatus(currentReview.run.summary),
        researchSufficiencyStatus: researchSufficiency.status,
        claims: currentReview.run.claims,
        decisions: currentReview.run.decisions,
      })
    : null;
  const reviewDisclosure = currentReview.run && currentReviewPublicationGate?.status === 'publish_with_disclosure'
    ? getReviewDisclosureItems({
        claims: currentReview.run.claims,
        decisions: currentReview.run.decisions,
      })
    : [];
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    title: r.title,
    body: r.body,
    background: r.background,
    conclusion: r.conclusion,
    risks: r.risks,
    tags: r.tags,
    authorId: r.authorId,
    creationMethod: r.creationMethod,
    aiAssisted: r.aiAssisted,
    supersedesResearchId: r.supersedesResearchId,
    reviewStatus: r.reviewStatus,
    reviewAttempts: r.reviewAttempts,
    reviewSummary: r.reviewSummary,
    reviewClaims: r.reviewClaims,
    reviewStartedAt: r.reviewStartedAt?.toISOString() ?? null,
    reviewRunToken: r.reviewRunToken,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    reviewDetails: r.reviewDetails,
    // Published AI research must carry the reader-facing consequence of an
    // accepted low/medium-risk exception. This is derived from the exact
    // current run, so it cannot survive an edit as if it still applied.
    reviewDisclosure,
    researchSufficiency,
    // `reviewRuns` is the audit trail. This projection is the single state
    // used by current-version UI decisions, so clients do not need to infer
    // whether a historical run still applies.
    currentReview: {
      revisionHash: currentReview.revisionHash,
      status: currentReview.status,
      outcome: currentReview.outcome,
      isCurrentRevision: currentReview.isCurrentRevision,
      isLegacyFallback: currentReview.isLegacyFallback,
      runId: currentReview.run?.id ?? null,
      executionStatus: currentReview.run?.executionStatus ?? null,
      attempt: currentReview.attempt,
      publicationGate: currentReviewPublicationGate,
      startedAt: currentReview.run?.startedAt
        ? new Date(currentReview.run.startedAt).toISOString()
        : null,
      completedAt: currentReview.run?.completedAt
        ? new Date(currentReview.run.completedAt).toISOString()
        : null,
    },
    reviewRuns: Array.isArray(r.reviewRuns)
      ? r.reviewRuns.map((run) => ({
          id: run.id,
          revisionHash: run.revisionHash,
          isCurrentRevision: run.revisionHash === currentRevisionHash,
          sourceSnapshotHash: run.sourceSnapshotHash,
          policyVersion: run.policyVersion,
          executionStatus: run.executionStatus,
          outcome: run.outcome,
          attempt: run.attempt,
          startedAt: run.startedAt?.toISOString() ?? null,
          leaseExpiresAt: run.leaseExpiresAt?.toISOString() ?? null,
          heartbeatAt: run.heartbeatAt?.toISOString() ?? null,
          completedAt: run.completedAt?.toISOString() ?? null,
          summary: run.summary,
          claims: run.claims,
          details: run.details,
          triggeredBy: run.triggeredBy,
          decisions: (run.decisions ?? []).map((decision) => ({
            id: decision.id,
            claimId: decision.claimId,
            revisionHash: decision.revisionHash,
            action: decision.action,
            reason: decision.reason,
            metadata: decision.metadata,
            actorId: decision.actorId,
            createdAt: decision.createdAt.toISOString(),
          })),
          createdAt: run.createdAt.toISOString(),
        }))
      : [],
    publishedAt: r.publishedAt?.toISOString() ?? null,
    featuredAt: r.featuredAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    author: { id: r.author.id, name: r.author.name },
  };
}

/** 计算 edit diff（浅层字段比较） */
function computeDiff(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(next)) {
    const from = prev[key];
    const to = next[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      diff[key] = { from, to };
    }
  }
  return diff;
}

interface RevisionAuditData {
  sourceMessageId: string;
  sourceIntent: 'revise';
  sourceQuestion: string;
  reason: string;
  sourceRefs: Prisma.InputJsonValue;
}

/**
 * Resolve revision provenance on the server. The client sends only the id of
 * the assistant answer it accepted; ownership, job linkage, question and
 * actual captured sources are all read again from the database.
 */
async function resolveRevisionAuditContext({
  sourceMessageId,
  reason,
  userId,
  aiJobId,
  sources,
  requestId,
}: {
  sourceMessageId: string;
  reason?: string;
  userId: string;
  aiJobId: string | null;
  sources: Array<{
    sourceRef: Prisma.JsonValue;
    canonicalKey: string;
    title: string | null;
    createdAt: Date;
  }>;
  requestId: string;
}): Promise<RevisionAuditData | NextResponse> {
  if (!aiJobId) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '只有 AI 调研草稿可以从追问生成修订',
      requestId,
    });
  }

  const sourceMessage = await prisma.aiResearchConversationMessage.findUnique({
    where: { id: sourceMessageId },
    select: {
      id: true,
      role: true,
      intent: true,
      createdAt: true,
      conversation: { select: { id: true, userId: true, jobId: true } },
    },
  });
  if (
    !sourceMessage
    || sourceMessage.role !== 'assistant'
    || sourceMessage.intent !== 'revise'
    || sourceMessage.conversation.userId !== userId
    || sourceMessage.conversation.jobId !== aiJobId
  ) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '追问回答与这份调研不匹配，无法生成修订',
      requestId,
    });
  }

  const conversation = await prisma.aiResearchConversation.findUnique({
    where: { id: sourceMessage.conversation.id },
    select: {
      messages: {
        where: {
          role: 'user',
          createdAt: { lt: sourceMessage.createdAt },
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { content: true },
      },
    },
  });
  const sourceQuestion = conversation?.messages[0]?.content?.trim();
  if (!sourceQuestion) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '找不到这次追问的问题，请重新发起追问',
      requestId,
    });
  }

  return {
    sourceMessageId,
    sourceIntent: 'revise',
    sourceQuestion: sourceQuestion.slice(0, 32_000),
    reason: (reason?.trim() || '根据本次追问补充报告').slice(0, 2_000),
    sourceRefs: sources.map((source) => ({
      sourceRef: source.sourceRef as Prisma.InputJsonValue,
      canonicalKey: source.canonicalKey,
      title: source.title,
      capturedAt: source.createdAt.toISOString(),
    })) as unknown as Prisma.InputJsonValue,
  };
}
