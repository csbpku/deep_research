// BFF handler: GET  /api/researches/[id] — 详情
//               PUT  /api/researches/[id] — 编辑（含 published 修改审计）
//
// 契约源：
//   - docs/contracts/state-machines.md §5: ResearchStatus
//   - 验收: draft 仅 owner 可见; published 全员可见
//   - 修改已发布内容 → $transaction 写 research_audit(diff)
//
// GET:  返回完整 research（含 audit history）
// PUT:  仅 owner 可改；published 时写 audit；任何失败整事务回滚

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
  sourceCommentId: true,
  publishedAt: true,
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
      message: '沉淀不存在',
      requestId,
    });
  }

  // 权限检查：draft 仅 owner 可见；published 全员可见
  if (research.status !== RESEARCH_STATUS.PUBLISHED && research.authorId !== u.id) {
    // 返回 404，不泄露草稿存在性
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '沉淀不存在',
      requestId,
    });
  }

  // 服务端 canEdit 计算（W4 review 修订：避免前端硬编码 isOwner = true）。
  // 仅 draft/published/archived 三种状态下：
  //   - author === me → canEdit = true
  //   - admin → canEdit = true（admin 可代编辑走 publish action 校验）
  // 注：admin 实际能不能改取决于 publish handler；前端仅做显隐。
  const canEdit = research.authorId === u.id || u.role === 'admin';

  // 读取审计历史
  const audits = await prisma.researchAudit.findMany({
    where: { researchId: research.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      action: true,
      diff: true,
      createdAt: true,
      editor: { select: { id: true, name: true, email: true } },
    },
  });

  // 长文（type='research'，已发布）→ 挂载 research_sources
  // 草稿不挂载（避免泄漏未发布调研的引用；架构 §十二）。
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

  if (research.status === RESEARCH_STATUS.PUBLISHED && research.type === 'research') {
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
    researchSources = sources;
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
      message: '沉淀不存在',
      requestId,
    });
  }

  // 仅 owner 可编辑
  if (existing.authorId !== u.id) {
    return toApiErrorResponse({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: '只能编辑自己的沉淀',
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

  // draft 状态：直接更新，不需要审计
  const updated = await prisma.research.update({
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
  publishedAt: Date | null;
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
    publishedAt: r.publishedAt?.toISOString() ?? null,
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
