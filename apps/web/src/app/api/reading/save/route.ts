import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { ReadingSaveInputSchema } from '@deep-research/shared/schemas';
import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { prisma } from '../../../../lib/db';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';
import { requireReadingUser } from '../../../../lib/reading-auth';

export const dynamic = 'force-dynamic';

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireReadingUser(req);
  if (user instanceof Response) return user;
  const input = await parseBody(req, ReadingSaveInputSchema);
  if (input instanceof NextResponse) return input;
  if (!input.quote.trim() && !input.note.trim() && !input.aiAnswer?.trim()) {
      return toApiErrorResponse({ code: 'VALIDATION_FAILED', message: '至少保存一段摘录、笔记或 AI 结论', requestId });
  }
  if (input.anchor && input.anchor.quote.trim() !== input.quote.trim()) {
    return toApiErrorResponse({
      code: 'VALIDATION_FAILED',
      message: '摘录已被编辑，原文锚点与当前摘录不一致；请重新选择原文或移除锚点后保存',
      requestId,
    });
  }
  if (input.anchor && (
    input.anchor.startOffset === undefined
    || input.anchor.endOffset === undefined
    || !input.anchor.contentHash
  )) {
    return toApiErrorResponse({
      code: 'VALIDATION_FAILED',
      message: '原文锚点缺少位置或内容指纹，请重新选择原文后保存',
      requestId,
    });
  }

  const readingSaveKey = input.idempotencyKey ?? randomUUID();

  const sections = [
    `> ${input.quote.trim().replaceAll('\n', '\n> ')}`,
    input.note.trim() ? `## 我的笔记\n\n${input.note.trim()}` : '',
    input.aiAnswer?.trim() ? `## AI 解读\n\n${input.aiAnswer.trim()}` : '',
  ].filter(Boolean);
  const body = sections.join('\n\n');
  const sourceRef = {
    type: 'url',
    value: input.url,
    anchor: input.anchor ?? null,
    capturedAt: new Date().toISOString(),
  } satisfies Prisma.InputJsonValue;

  let created: { id: string; title: string; status: string; createdAt: Date };
  let deduplicated = false;
  try {
    created = await prisma.$transaction(async (tx) => {
      const research = await tx.research.create({
        data: {
          type: 'knowledge',
          status: 'draft',
          title: input.title,
          body,
          conclusion: input.aiAnswer?.trim().slice(0, 2_000) || input.note.trim().slice(0, 2_000) || null,
          tags: input.tags,
          authorId: user.id,
          creationMethod: 'manual',
          aiAssisted: Boolean(input.aiAnswer?.trim()),
          readingSaveKey,
        },
        select: { id: true, title: true, status: true, createdAt: true },
      });
      await tx.researchSource.create({
        data: {
          researchId: research.id,
          sourceRef,
          canonicalKey: input.url,
          title: input.title,
          description: input.quote.slice(0, 1_000),
        },
      });
      await tx.researchAudit.create({
        data: {
          researchId: research.id,
          editorId: user.id,
          action: 'create',
          diff: { origin: 'browser_reading', url: input.url, hasAnchor: Boolean(input.anchor) } as Prisma.InputJsonValue,
        },
      });
      return research;
    });
  } catch (error) {
    // The unique key is the database-level race winner. If another retry won
    // between our initial request and this transaction, return that draft
    // instead of exposing a generic 500 or creating a second source row.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const existing = await prisma.research.findFirst({
      where: { authorId: user.id, readingSaveKey },
      select: { id: true, title: true, status: true, createdAt: true },
    });
    if (!existing) throw error;
    created = existing;
    deduplicated = true;
  }
  return NextResponse.json({
    ok: true,
    draft: { id: created.id, title: created.title, status: created.status, createdAt: created.createdAt.toISOString() },
    deduplicated,
    requestId,
  }, { status: deduplicated ? 200 : 201 });
});
