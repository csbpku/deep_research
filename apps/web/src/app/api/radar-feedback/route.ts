// BFF handler: POST /api/radar-feedback — 提交雷达反馈（幂等）
//               DELETE /api/radar-feedback — 撤回反馈（toggle 语义）
//
// 契约源：
//   - apps/web/prisma/schema.prisma: RadarFeedback @@unique([summaryId, userId, feedbackType])
//   - docs/contracts/error-codes.md §通用: VALIDATION_FAILED 400 / PERMISSION_DENIED 403
//
// 幂等性：DB 唯一约束保证；同 (summaryId, userId, feedbackType) 重复 POST 返回 200
// 不创建新行；DELETE 不存在则返回 200 + done=false（前端不强提示）。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../lib/db';
import { apiHandler, parseBody } from '../../../lib/api-handler';
import { requireUser } from '../../../lib/auth/session';
import { toApiErrorResponse } from '../../../lib/errors';
import { log, withRequestId } from '../../../lib/log';
import {
  CreateRadarFeedbackInput,
  DeleteRadarFeedbackQuery,
} from '../../../lib/schemas';
import { RADAR_FEEDBACK_TYPE } from '@deep-research/shared/states';
import { ERROR_CODES } from '@deep-research/shared/errors';

// ─── POST /api/radar-feedback ─────────────────────────────────────────

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const body = await parseBody(req, CreateRadarFeedbackInput);
  if (body instanceof NextResponse) return body;

  // 校验 summary 存在且来自雷达（source='daily' 且 syncRunId 非空）
  const summary = await prisma.summary.findUnique({
    where: { id: body.summaryId },
    select: { id: true, source: true, syncRunId: true },
  });
  if (!summary || summary.source !== 'daily' || summary.syncRunId === null) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '雷达候选不存在',
      requestId,
    });
  }

  // 幂等 upsert；冲突（P2002）视为已存在，返回 200 done=false
  let created = false;
  try {
    await prisma.radarFeedback.create({
      data: {
        summaryId: body.summaryId,
        userId: u.id,
        feedbackType: body.feedbackType,
      },
      select: { id: true },
    });
    created = true;
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'P2002') {
      created = false;
    } else {
      throw err;
    }
  }

  // 计数 + 当前用户已选反馈
  const counts = await prisma.radarFeedback.groupBy({
    by: ['feedbackType'],
    where: { summaryId: body.summaryId },
    _count: { feedbackType: true },
  });
  const feedbackCounts = {
    useful: 0,
    inaccurate: 0,
    used: 0,
    favorite: 0,
    suggest_research: 0,
  };
  for (const row of counts) {
    const ft = row.feedbackType as keyof typeof feedbackCounts;
    if (ft in feedbackCounts) feedbackCounts[ft] = row._count.feedbackType;
  }

  log.info('radar.feedback.create', 'feedback recorded', {
    requestId,
    userId: u.id,
    summaryId: body.summaryId,
    feedbackType: body.feedbackType,
    created,
  });

  return NextResponse.json({
    ok: true,
    created,
    summaryId: body.summaryId,
    feedbackType: body.feedbackType,
    feedbackCounts,
  });
});

// ─── DELETE /api/radar-feedback ──────────────────────────────────────

export const DELETE = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const url = new URL(req.url);
  const parsed = DeleteRadarFeedbackQuery.safeParse({
    summaryId: url.searchParams.get('summaryId') ?? undefined,
    feedbackType: url.searchParams.get('feedbackType') ?? undefined,
  });
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'summaryId / feedbackType 必须提供',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // 不存在则不报错（toggle 语义：用户可能点击两次）
  const result = await prisma.radarFeedback.deleteMany({
    where: {
      summaryId: parsed.data.summaryId,
      userId: u.id,
      feedbackType: parsed.data.feedbackType,
    },
  });

  log.info('radar.feedback.delete', 'feedback removed', {
    requestId,
    userId: u.id,
    summaryId: parsed.data.summaryId,
    feedbackType: parsed.data.feedbackType,
    removed: result.count,
  });

  // 计数（重新聚合）
  const counts = await prisma.radarFeedback.groupBy({
    by: ['feedbackType'],
    where: { summaryId: parsed.data.summaryId },
    _count: { feedbackType: true },
  });
  const feedbackCounts = {
    useful: 0,
    inaccurate: 0,
    used: 0,
    favorite: 0,
    suggest_research: 0,
  };
  for (const row of counts) {
    const ft = row.feedbackType as keyof typeof feedbackCounts;
    if (ft in feedbackCounts) feedbackCounts[ft] = row._count.feedbackType;
  }

  return NextResponse.json({
    ok: true,
    removed: result.count,
    summaryId: parsed.data.summaryId,
    feedbackType: parsed.data.feedbackType,
    feedbackCounts,
  });
});

// 显式列出 RADAR_FEEDBACK_TYPE 防止被 tree-shake / lint 警告
void RADAR_FEEDBACK_TYPE;