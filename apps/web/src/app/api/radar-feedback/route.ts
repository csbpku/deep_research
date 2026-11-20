// BFF handler: POST /api/radar-feedback — 提交雷达反馈（幂等）
//               DELETE /api/radar-feedback — 撤回反馈（toggle 语义）
//
// 契约源：
//   - apps/web/prisma/schema.prisma: RadarFeedback @@unique([summaryId, userId, feedbackType])
//   - docs/contracts/error-codes.md §通用: VALIDATION_FAILED 400 / PERMISSION_DENIED 403
//
// 幂等性：DB 唯一约束保证；同 (summaryId, userId, feedbackType) 重复 POST 返回 200
// 不创建新行；DELETE 不存在则返回 200 + done=false（前端不强提示）。
//
// P0-4：四个判断（read/later/pilot/inaccurate）除计数外还维护
// summaries.judgmentScore。写入、计数、重算在同一个事务内完成；重算前对
// summary 取事务级 advisory lock，避免并发请求读到旧快照后互相覆盖。

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
import { ERROR_CODES } from '@deep-research/shared/errors';
import { emptyFeedbackCounts, type RadarFeedbackCount } from '../../../lib/radar/shape';
import {
  isRadarJudgmentType,
  lockJudgmentAggregate,
  recomputeSummaryJudgmentScore,
} from '../../../lib/radar/judgment-score';
import { isRadarSummaryVisible, radarVisibilitySelect } from '../../../lib/radar/visibility';
import type { Prisma } from '@prisma/client';

/** 在事务内重新聚合 8 类反馈计数（含刚写入/删除的那一条）。 */
async function readFeedbackCounts(
  tx: Pick<Prisma.TransactionClient, 'radarFeedback'>,
  summaryId: string,
): Promise<RadarFeedbackCount> {
  const rows = await tx.radarFeedback.groupBy({
    by: ['feedbackType'],
    where: { summaryId },
    _count: { feedbackType: true },
  });
  const counts = emptyFeedbackCounts();
  for (const row of rows) {
    const type = row.feedbackType as keyof RadarFeedbackCount;
    if (type in counts) counts[type] = row._count.feedbackType;
  }
  return counts;
}

// ─── POST /api/radar-feedback ─────────────────────────────────────────

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const body = await parseBody(req, CreateRadarFeedbackInput);
  if (body instanceof NextResponse) return body;

  // 校验 summary 存在、来自雷达，且对当前用户可见。没有这层 gate，
  // 成员可以对隐藏/未发布的 UUID 写判断并影响全局排序，也能把 404/200
  // 当作“这行是否存在”的探针。
  const summary = await prisma.summary.findUnique({
    where: { id: body.summaryId },
    select: { ...radarVisibilitySelect, status: true },
  });
  if (
    !summary
    || summary.source !== 'daily'
    || summary.syncRunId === null
    || summary.status === 'archived'
    || !isRadarSummaryVisible(summary, u.role === 'admin')
  ) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '雷达候选不存在',
      requestId,
    });
  }

  const outcome = await prisma.$transaction(async (tx) => {
    await lockJudgmentAggregate(tx, body.summaryId);

    // createMany + skipDuplicates 同时覆盖“新建”和“重复点击”：返回 count=0
    // 即已存在。favorite 仍额外镜像到 user_bookmarks，两条记录同事务提交。
    const inserted = await tx.radarFeedback.createMany({
      data: [
        {
          summaryId: body.summaryId,
          userId: u.id,
          feedbackType: body.feedbackType,
        },
      ],
      skipDuplicates: true,
    });

    if (body.feedbackType === 'favorite') {
      await tx.userBookmark.upsert({
        where: {
          userId_targetType_targetId: {
            userId: u.id,
            targetType: 'radar_candidate',
            targetId: body.summaryId,
          },
        },
        create: { userId: u.id, targetType: 'radar_candidate', targetId: body.summaryId },
        update: {},
      });
    }

    const feedbackCounts = await readFeedbackCounts(tx, body.summaryId);
    const judgmentScore = isRadarJudgmentType(body.feedbackType)
      ? await recomputeSummaryJudgmentScore(tx, body.summaryId)
      : null;

    return { created: inserted.count > 0, feedbackCounts, judgmentScore };
  });

  log.info('radar.feedback.create', 'feedback recorded', {
    requestId,
    userId: u.id,
    summaryId: body.summaryId,
    feedbackType: body.feedbackType,
    created: outcome.created,
    judgmentScore: outcome.judgmentScore,
  });

  return NextResponse.json({
    ok: true,
    created: outcome.created,
    summaryId: body.summaryId,
    feedbackType: body.feedbackType,
    feedbackCounts: outcome.feedbackCounts,
    judgmentScore: outcome.judgmentScore,
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

  const { summaryId, feedbackType } = parsed.data;
  const outcome = await prisma.$transaction(async (tx) => {
    await lockJudgmentAggregate(tx, summaryId);

    // 不存在也不报错（toggle 语义：用户可能点击两次）
    const removed = await tx.radarFeedback.deleteMany({
      where: { summaryId, userId: u.id, feedbackType },
    });
    if (feedbackType === 'favorite') {
      await tx.userBookmark.deleteMany({
        where: {
          userId: u.id,
          targetType: 'radar_candidate',
          targetId: summaryId,
        },
      });
    }

    const feedbackCounts = await readFeedbackCounts(tx, summaryId);
    const judgmentScore = isRadarJudgmentType(feedbackType)
      ? await recomputeSummaryJudgmentScore(tx, summaryId)
      : null;

    return { removed: removed.count, feedbackCounts, judgmentScore };
  });

  log.info('radar.feedback.delete', 'feedback removed', {
    requestId,
    userId: u.id,
    summaryId,
    feedbackType,
    removed: outcome.removed,
    judgmentScore: outcome.judgmentScore,
  });

  return NextResponse.json({
    ok: true,
    removed: outcome.removed,
    summaryId,
    feedbackType,
    feedbackCounts: outcome.feedbackCounts,
    judgmentScore: outcome.judgmentScore,
  });
});
