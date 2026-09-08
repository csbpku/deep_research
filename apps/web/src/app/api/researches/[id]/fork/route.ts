// BFF handler: POST /api/researches/[id]/fork — 从已发布版本创建私有修订草稿。
//
// AI 调研的审核结果绑定的是一个具体正文版本。已发布 AI 研究因此不能
// 原地编辑；本接口复制正文、资料和引用到新的 draft，之后由新草稿重新
// 走“编辑 → 审核 → 发布”流程。

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { apiHandler } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { prisma } from '../../../../../lib/db';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { log, withRequestId } from '../../../../../lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { RESEARCH_STATUS } from '@deep-research/shared/states';
import { hashResearchRevision } from '../../../../../lib/research-revision';

const IdParam = z.object({ id: z.string().uuid() });

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

  const existing = await prisma.research.findUnique({
    where: { id: parsed.data.id },
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
      sourceCommentId: true,
      researchSources: {
        orderBy: { createdAt: 'asc' },
        select: {
          sourceRef: true,
          canonicalKey: true,
          title: true,
          description: true,
          citations: {
            orderBy: { createdAt: 'asc' },
            select: {
              marker: true,
              quote: true,
              startOffset: true,
              endOffset: true,
              contentHash: true,
            },
          },
        },
      },
    },
  });

  if (!existing || existing.status !== RESEARCH_STATUS.PUBLISHED) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '只有已发布的调研可以创建修订草稿',
      requestId,
    });
  }

  if (existing.authorId !== user.id && user.role !== 'admin') {
    return toApiErrorResponse({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: '没有权限创建这份调研的修订草稿',
      requestId,
    });
  }

  const snapshot = {
    title: existing.title,
    body: existing.body,
    background: existing.background,
    conclusion: existing.conclusion,
    risks: existing.risks,
    tags: existing.tags,
  };
  const originContentSha256 = existing.creationMethod === 'ai_research'
    ? createHash('sha256').update(existing.body, 'utf8').digest('hex')
    : null;

  const draft = await prisma.$transaction(async (tx) => {
    const created = await tx.research.create({
      data: {
        type: existing.type,
        status: RESEARCH_STATUS.DRAFT,
        title: existing.title,
        body: existing.body,
        background: existing.background,
        conclusion: existing.conclusion,
        risks: existing.risks,
        tags: existing.tags,
        authorId: user.id,
        creationMethod: existing.creationMethod,
        aiAssisted: false,
        originContentSha256,
        sourceCommentId: existing.sourceCommentId,
        supersedesResearchId: existing.id,
        researchSources: {
          create: existing.researchSources.map((source) => ({
            sourceRef: source.sourceRef as Prisma.InputJsonValue,
            canonicalKey: source.canonicalKey,
            title: source.title,
            description: source.description,
          })),
        },
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
        supersedesResearchId: true,
        publishedAt: true,
        createdAt: true,
        updatedAt: true,
        researchSources: { select: { id: true, canonicalKey: true } },
      },
    });

    const createdSources = new Map(created.researchSources.map((source) => [source.canonicalKey, source.id]));
    for (const source of existing.researchSources) {
      const sourceId = createdSources.get(source.canonicalKey);
      if (!sourceId || source.citations.length === 0) continue;
      await tx.researchCitation.createMany({
        data: source.citations.map((citation) => ({
          researchId: created.id,
          sourceId,
          marker: citation.marker,
          quote: citation.quote,
          startOffset: citation.startOffset,
          endOffset: citation.endOffset,
          contentHash: citation.contentHash,
        })),
      });
    }

    if (existing.creationMethod === 'ai_research') {
      await tx.researchReviewRun.create({
        data: {
          researchId: created.id,
          revisionHash: hashResearchRevision(existing),
          sourceSnapshotHash: hashSourceSnapshot(existing.researchSources),
          policyVersion: 'fact-review-v1',
          executionStatus: 'queued',
          attempt: 0,
          triggeredBy: 'revision_fork',
          details: {
            phase: 'queued',
            status: 'queued',
            attempts: 0,
            source: 'revision_fork',
          } as Prisma.InputJsonValue,
        },
      });
    }

    await tx.researchAudit.create({
      data: {
        researchId: created.id,
        editorId: user.id,
        action: 'create',
        prevSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        reason: `从已发布版本 ${existing.id} 创建修订草稿`,
      },
    });
    return created;
  });

  log.info('research.fork', 'revision draft created', {
    requestId,
    userId: user.id,
    researchId: existing.id,
    revisionResearchId: draft.id,
  });

  return NextResponse.json({
    id: draft.id,
    type: draft.type,
    status: draft.status,
    title: draft.title,
    body: draft.body,
    background: draft.background,
    conclusion: draft.conclusion,
    risks: draft.risks,
    tags: draft.tags,
    authorId: draft.authorId,
    creationMethod: draft.creationMethod,
    aiAssisted: draft.aiAssisted,
    supersedesResearchId: draft.supersedesResearchId,
    publishedAt: draft.publishedAt?.toISOString() ?? null,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
    author: { id: user.id, name: user.name },
  }, { status: 201 });
});

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashSourceSnapshot(sources: Array<{
  sourceRef: unknown;
  canonicalKey: string;
  title: string | null;
  description: string | null;
}>): string {
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
