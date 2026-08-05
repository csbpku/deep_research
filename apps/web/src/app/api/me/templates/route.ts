// BFF handler: GET/POST /api/me/templates — 当前用户的调研模板。
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';

const postSchema = z.object({
  title: z.string().min(1).max(200),
  topic: z.string().min(2).max(200),
  background: z.string().max(2000).optional(),
  reportType: z.enum(['research_report', 'summary_brief']).default('research_report'),
  sourcePolicy: z
    .enum(['prefer_user_sources', 'only_user_sources', 'web_only'])
    .default('prefer_user_sources'),
  tags: z.array(z.string().min(1).max(40)).max(10).default([]),
});

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const requestId = withRequestId(req.headers);
  const items = await prisma.researchTemplate.findMany({
    where: { ownerId: user.id },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });
  return NextResponse.json({
    items: items.map((t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    })),
    requestId,
  });
});

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const requestId = withRequestId(req.headers);

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await req.json());
  } catch (err) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: err instanceof Error ? err.message : '请求体非法',
      requestId,
    });
  }

  const created = await prisma.researchTemplate.create({
    data: {
      ownerId: user.id,
      title: body.title,
      topic: body.topic,
      background: body.background,
      reportType: body.reportType,
      sourcePolicy: body.sourcePolicy,
      tags: body.tags,
    },
  });
  return NextResponse.json(
    { ok: true, id: created.id, requestId },
    { status: 201 },
  );
});
