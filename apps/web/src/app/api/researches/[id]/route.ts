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
import { prisma } from '../../../../lib/db.js';
import { apiHandler, parseBody } from '../../../../lib/api-handler.js';
import { requireUser } from '../../../../lib/auth/session.js';
import { toApiErrorResponse } from '../../../../lib/errors.js';
import { log, withRequestId } from '../../../../lib/log.js';
import { UpdateResearchInput } from '../../../../lib/schemas.js';
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
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true, email: true } },
  _count: { select: { comments: true } },
} as const;

// ─── GET /api/researches/[id] ─────────────────────────────────────────

export const GET = apiHandler<[NextRequest, { params: { id: string } }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const parsed = IdParam.safeParse(ctx.params);
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

  return NextResponse.json({
    ...shapeResearchDetail(research),
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

export const PUT = apiHandler<[NextRequest, { params: { id: string } }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const parsed = IdParam.safeParse(ctx.params);
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
