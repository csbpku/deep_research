import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler, parseBody } from '@/lib/api-handler';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { RadarIdParam } from '@/lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';

const AddTopicInput = z.object({
  topicId: z.string().uuid(),
}).strict();

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const parsedId = RadarIdParam.safeParse(await ctx.params);
  if (!parsedId.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
    });
  }
  const body = await parseBody(req, AddTopicInput);
  if (body instanceof NextResponse) return body;

  const [summary, topic] = await Promise.all([
    prisma.summary.findUnique({
      where: { id: parsedId.data.id },
      select: { id: true, source: true, syncRunId: true, status: true },
    }),
    prisma.topic.findFirst({
      where: { id: body.topicId, enabled: true },
      select: { id: true, slug: true, name: true, tier: true },
    }),
  ]);
  const visible = summary
    && ((summary.source === 'daily' && summary.syncRunId !== null)
      || (summary.source === 'user' && summary.status === 'published'));
  if (!visible) {
    return toApiErrorResponse({ code: ERROR_CODES.DRAFT_NOT_FOUND, message: '雷达候选不存在', requestId });
  }
  if (!topic) {
    return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '专题不存在或已停用', requestId });
  }

  await prisma.topicCandidate.upsert({
    where: { topicId_summaryId: { topicId: topic.id, summaryId: summary.id } },
    create: { topicId: topic.id, summaryId: summary.id, addedReason: 'admin_manual' },
    update: { addedReason: 'admin_manual' },
  });

  return NextResponse.json({ topic }, { status: 201 });
});
