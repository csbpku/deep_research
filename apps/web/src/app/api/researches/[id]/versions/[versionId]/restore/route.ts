// Restore a research version atomically and record the restore as a new audit.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { RESEARCH_STATUS } from '@deep-research/shared/states';
import {
  confirmedKnowledgeIndexText,
  queuePersonalKnowledgeIndex,
  readingKnowledgeIndexTextFromBody,
} from '../../../../../../../lib/personal-knowledge-index';
import { prisma } from '../../../../../../../lib/db';
import { apiHandler } from '../../../../../../../lib/api-handler';
import { requireUser } from '../../../../../../../lib/auth/session';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { toApiErrorResponse } from '../../../../../../../lib/errors';
import { withRequestId } from '../../../../../../../lib/log';

const Params = z.object({ id: z.string().uuid(), versionId: z.string().uuid() });

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string; versionId: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '参数不合法', requestId });
  }

  const research = await prisma.research.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      authorId: true,
      status: true,
      creationMethod: true,
      type: true,
      readingSaveKey: true,
      sourceAiJob: { select: { id: true } },
    },
  });
  // 与 PUT /api/researches/[id] 同一规则：owner 可操作自己的任意状态；
  // admin 仅可操作已发布内容，不能写入他人的私有草稿/归档（对外同样表现为 404，不暴露存在性）。
  if (
    !research
    || (research.authorId !== user.id
      && !(user.role === 'admin' && research.status === RESEARCH_STATUS.PUBLISHED))
  ) {
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: '调研库不存在', requestId });
  }
  if (research.status === 'published' && research.creationMethod === 'ai_research') {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_PUBLISHED_IMMUTABLE,
      message: '已发布的 AI 调研不可原地恢复，请先创建修订草稿',
      requestId,
    });
  }

  const audit = await prisma.researchAudit.findFirst({
    where: { id: parsed.data.versionId, researchId: research.id },
    select: { id: true, prevSnapshot: true },
  });
  const snapshot = audit?.prevSnapshot;
  if (!audit || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: '版本不存在或不可恢复', requestId });
  }

  const value = snapshot as Record<string, unknown>;
  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.research.findUnique({
      where: { id: research.id },
      select: { title: true, body: true, background: true, conclusion: true, risks: true, tags: true },
    });
    if (!current) throw new Error('research disappeared');
    const next: Record<string, unknown> & { title: string; body: string; background: string | null; conclusion: string | null; risks: string | null; tags: string[] } = {
      title: typeof value.title === 'string' ? value.title : current.title,
      body: typeof value.body === 'string' ? value.body : current.body,
      background: typeof value.background === 'string' ? value.background : null,
      conclusion: typeof value.conclusion === 'string' ? value.conclusion : null,
      risks: typeof value.risks === 'string' ? value.risks : null,
      tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : current.tags,
    };
    const diff = computeDiff(current, next);
    const contentChanged = Object.keys(diff).length > 0;
    const knowledgeIndexText = research.type === 'knowledge'
      ? research.readingSaveKey && research.creationMethod === 'manual'
        ? readingKnowledgeIndexTextFromBody(next.body)
        : confirmedKnowledgeIndexText(next)
      : undefined;
    if (contentChanged) {
      // 与 PUT 一致：旧审核结论只对旧内容有效，恢复后必须作废并让在途审核失效。
      const reviewRuns = (tx as typeof tx & {
        researchReviewRun?: { updateMany: (args: unknown) => Promise<unknown> };
      }).researchReviewRun;
      if (reviewRuns) {
        await reviewRuns.updateMany({
          where: { researchId: research.id, executionStatus: { in: ['queued', 'reviewing'] } },
          data: { executionStatus: 'stale', outcome: 'stale', completedAt: new Date() },
        });
      }
      const clearedReview = {
        reviewStatus: null,
        reviewAttempts: 0,
        reviewSummary: Prisma.DbNull,
        reviewClaims: [] as Prisma.InputJsonValue,
        reviewedAt: null,
        reviewStartedAt: null,
        reviewRunToken: null,
        reviewDetails: Prisma.DbNull,
      };
      const aiResearchJob = (tx as { aiResearchJob?: { update?: (args: unknown) => Promise<unknown> } }).aiResearchJob;
      if (research.sourceAiJob?.id && aiResearchJob?.update) {
        await aiResearchJob.update({ where: { id: research.sourceAiJob.id }, data: clearedReview });
      }
      Object.assign(next, clearedReview);
    }
    const result = await tx.research.update({
      where: { id: research.id },
      data: {
        ...next,
        ...(research.type === 'knowledge' && contentChanged ? { knowledgeIndexText } : {}),
      },
    });
    if (contentChanged && research.type === 'knowledge') {
      await queuePersonalKnowledgeIndex(tx, {
        ownerId: research.authorId,
        researchId: research.id,
        operation: knowledgeIndexText ? 'upsert' : 'delete',
      });
    }
    await tx.researchAudit.create({
      data: {
        researchId: research.id,
        editorId: user.id,
        action: 'revert',
        diff: diff as never,
        prevSnapshot: current as never,
      },
    });
    return result;
  });

  return NextResponse.json({
    ok: true,
    research: {
      id: updated.id,
      title: updated.title,
      body: updated.body,
      background: updated.background,
      conclusion: updated.conclusion,
      risks: updated.risks,
      tags: updated.tags,
    },
  });
});

function computeDiff(prev: Record<string, unknown>, next: Record<string, unknown>) {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(next)) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) diff[key] = { from: prev[key], to: next[key] };
  }
  return diff;
}
