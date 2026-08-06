// Restore a research version atomically and record the restore as a new audit.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
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
    select: { id: true, authorId: true, status: true },
  });
  if (!research || (research.authorId !== user.id && user.role !== 'admin')) {
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: '调研库不存在', requestId });
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
    const next = {
      title: typeof value.title === 'string' ? value.title : current.title,
      body: typeof value.body === 'string' ? value.body : current.body,
      background: typeof value.background === 'string' ? value.background : null,
      conclusion: typeof value.conclusion === 'string' ? value.conclusion : null,
      risks: typeof value.risks === 'string' ? value.risks : null,
      tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : current.tags,
    };
    const diff = computeDiff(current, next);
    const result = await tx.research.update({ where: { id: research.id }, data: next });
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
