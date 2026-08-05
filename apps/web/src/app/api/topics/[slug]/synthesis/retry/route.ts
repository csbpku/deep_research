// BFF handler: POST /api/topics/[slug]/synthesis/retry — Admin 触发主题 AI 综述重试 (P1-D)。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth/session';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const POST = apiHandler<[NextRequest, { params: Promise<{ slug: string }> }]>(async (req, ctx) => {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const requestId = withRequestId(req.headers);
  const { slug } = await ctx.params;
  if (!slug) {
    return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: 'slug 必填', requestId });
  }
  const topic = await prisma.topic.findUnique({ where: { slug }, select: { id: true, candidateCount: true } });
  if (!topic) {
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: 'topic 不存在', requestId });
  }
  if (topic.candidateCount === 0) {
    return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '主题无候选，无法重试综述', requestId });
  }
  // 清错 + 标记 pending；实际 LLM 调用由 ai-engine 端 topic_synthesis worker 拉取
  await prisma.topic.update({
    where: { id: topic.id },
    data: { synthesisErrorCode: null, synthesisErrorMessage: null, synthesisGeneratedAt: null },
  });
  return NextResponse.json({ ok: true, slug, requestId });
});
