// BFF handler: POST /api/researches/[id]/publish — 发布草稿。
//
// 契约源：
//   - docs/contracts/state-machines.md §5: draft → published
//   - 验收: 仅 owner 可发布；已发布报 409；审计失败时事务回滚
//
// 行为：校验 owner + draft 状态 → 写 publish audit + 更新 status

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../../lib/db.js';
import { apiHandler } from '../../../../../lib/api-handler.js';
import { requireUser } from '../../../../../lib/auth/session.js';
import { toApiErrorResponse } from '../../../../../lib/errors.js';
import { log, withRequestId } from '../../../../../lib/log.js';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { RESEARCH_STATUS } from '@deep-research/shared/states';

const IdParam = z.object({ id: z.string().uuid() });

export const POST = apiHandler<[NextRequest, { params: { id: string } }]>(async (req, ctx) => {
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

  const existing = await prisma.research.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, authorId: true, status: true, title: true, body: true },
  });

  if (!existing) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '沉淀不存在',
      requestId,
    });
  }

  // 仅 owner 可发布
  if (existing.authorId !== u.id) {
    return toApiErrorResponse({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: '只能发布自己的沉淀',
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

  // $transaction: update status + audit —— 审计失败时正文修改整体回滚
  const result = await prisma.$transaction(async (tx) => {
    const published = await tx.research.update({
      where: { id: parsed.data.id },
      data: {
        status: RESEARCH_STATUS.PUBLISHED,
        publishedAt: new Date(),
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
