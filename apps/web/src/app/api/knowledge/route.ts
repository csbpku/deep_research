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
  resolveKnowledgeSource,
} from '../../../lib/knowledge-card';

const Input = z.object({
  sourceKind: z.enum(KNOWLEDGE_SOURCE_KINDS),
  messageId: z.string().uuid(),
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
      message: '只能保存自己会话中的 AI 回答',
      requestId,
    });
  }

  const knowledge = await prisma.$transaction(async (tx) => {
    const created = await tx.research.create({
      data: {
        type: 'knowledge',
        status: 'published',
        title: input.title,
        body: input.body,
        conclusion: input.conclusion || null,
        tags: input.tags,
        authorId: user.id,
        creationMethod: 'ai_research',
        aiAssisted: true,
        originContentSha256: createHash('sha256').update(source.content).digest('hex'),
        publishedAt: new Date(),
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

    await tx.researchAudit.create({
      data: {
        researchId: created.id,
        editorId: user.id,
        action: 'create',
        diff: {
          sourceKind: input.sourceKind,
          sourceMessageId: source.messageId,
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
