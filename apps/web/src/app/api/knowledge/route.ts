import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { apiHandler, parseBody } from '../../../lib/api-handler';
import { requireUser } from '../../../lib/auth/session';
import { prisma } from '../../../lib/db';
import { toApiErrorResponse } from '../../../lib/errors';
import { withRequestId } from '../../../lib/log';
import {
  KNOWLEDGE_SOURCE_KINDS,
  isSelectedKnowledgeText,
  resolveKnowledgeSource,
} from '../../../lib/knowledge-card';
import { confirmedKnowledgeIndexText, queuePersonalKnowledgeIndex } from '../../../lib/personal-knowledge-index';

const Input = z.object({
  sourceKind: z.enum(KNOWLEDGE_SOURCE_KINDS),
  messageId: z.string().uuid(),
  selectedText: z.string().trim().min(8).max(5_000),
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(50_000),
  conclusion: z.string().trim().max(2_000).optional().default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
}).strict();

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const input = await parseBody(req, Input);
  if (input instanceof NextResponse) return input;
  const source = await resolveKnowledgeSource(input.sourceKind, input.messageId, user.id);
  if (!source) {
    return toApiErrorResponse({
      code: 'PERMISSION_DENIED' as const,
      message: '只能使用自己有权限的 AI 回答或研究稿',
      requestId,
    });
  }
  if (!isSelectedKnowledgeText(source.content, input.selectedText)) {
    return toApiErrorResponse({
      code: 'VALIDATION_FAILED' as const,
      message: '所选内容已不在来源中，请重新选择后再保存',
      requestId,
    });
  }

  const knowledge = await prisma.$transaction(async (tx) => {
    const created = await tx.research.create({
      data: {
        type: 'knowledge',
        status: 'draft',
        title: input.title,
        body: input.body,
        conclusion: input.conclusion || null,
        knowledgeIndexText: confirmedKnowledgeIndexText(input),
        tags: input.tags,
        authorId: user.id,
        creationMethod: 'ai_research',
        aiAssisted: true,
        originContentSha256: createHash('sha256').update(input.selectedText).digest('hex'),
      },
      select: {
        id: true,
        title: true,
        status: true,
        publishedAt: true,
      },
    });

    for (const sourceRef of source.sources) {
      await tx.researchSource.create({
        data: {
          researchId: created.id,
          sourceRef: sourceRef.sourceRef as Prisma.InputJsonValue,
          canonicalKey: sourceRef.canonicalKey,
          title: sourceRef.title,
          description: sourceRef.description,
        },
      });
    }

    await queuePersonalKnowledgeIndex(tx, {
      ownerId: user.id,
      researchId: created.id,
      operation: 'upsert',
    });

    await tx.researchAudit.create({
      data: {
        researchId: created.id,
        editorId: user.id,
        action: 'create',
        diff: {
          sourceKind: input.sourceKind,
          sourceMessageId: source.messageId,
          selectedTextLength: input.selectedText.length,
          sourceCount: source.sources.length,
        } as Prisma.InputJsonValue,
      },
    });
    return created;
  });

  return NextResponse.json({
    ok: true,
    knowledge: {
      id: knowledge.id,
      title: knowledge.title,
      status: knowledge.status,
      publishedAt: knowledge.publishedAt?.toISOString() ?? null,
    },
  }, { status: 201 });
});
