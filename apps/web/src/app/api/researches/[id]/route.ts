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
// PUT:  owner 可改自己的内容；admin 仅可改已发布内容；published 时写 audit；
//       任何失败整事务回滚

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
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
  reviewStatus: true,
  reviewAttempts: true,
  reviewSummary: true,
  reviewClaims: true,
  reviewedAt: true,
  reviewDetails: true,
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
      createdAt: true,
      editor: { select: { id: true, name: true, email: true } },
    },
  });

  // 长文（type='research'）挂载来源；草稿仅对 owner 可见，因此可用于
  // 编辑器中的证据核对和后续 Reviewer 重审。
  // 精华（type='knowledge'）→ 不挂 research_sources，只挂 sourceComment 跳转。
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

  if (research.type === 'research') {
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
    select: { id: true, title: true, body: true, background: true, conclusion: true, risks: true, tags: true, authorId: true, status: true, creationMethod: true, aiAssisted: true },
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
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.research.update({
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
    if (saveMode === 'manual' && Object.keys(diff).length > 0) {
      await tx.researchAudit.create({
        data: {
          researchId: parsed.data.id,
          editorId: u.id,
          action: 'edit',
          diff: diff as unknown as Prisma.InputJsonValue,
          prevSnapshot: prevSnapshot as unknown as Prisma.InputJsonValue,
        },
      });
    }
    return next;
  });

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
  reviewStatus: string | null;
  reviewAttempts: number;
  reviewSummary: unknown;
  reviewClaims: unknown;
  reviewedAt: Date | null;
  reviewDetails: unknown;
  publishedAt: Date | null;
  featuredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  author: { id: string; name: string; email: string };
}) {
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
    reviewStatus: r.reviewStatus,
    reviewAttempts: r.reviewAttempts,
    reviewSummary: r.reviewSummary,
    reviewClaims: r.reviewClaims,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    reviewDetails: r.reviewDetails,
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
