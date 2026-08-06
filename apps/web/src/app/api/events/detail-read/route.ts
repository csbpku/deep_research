// BFF handler: 客户端详情阅读完成事件（Week 13 决策指标）。
//
// 契约源：
//   - docs/contracts/metrics.md §客户端事件校验：
//     * eventName / userId / occurredAt 必须由服务端填写，不接受客户端传
//     * foregroundSeconds ≥ 30 AND scrollPercent ≥ 50（zod 已在 schema 上强制）
//     * 去重 user + entity + ISO week（写入 product_events.dedupeKey）
//   - packages/shared/src/schemas.ts DetailReadCompletedInput
//   - packages/shared/src/metrics.ts PRODUCT_EVENT_NAME.DETAIL_READ_COMPLETED
//
// 验收 5：
//   - BFF 校验 30s + 50% 双条件（zod min 已强制）
//   - 服务端不信任客户端 eventName（强制覆盖为 'detail_read_completed'）
//   - userId 从 session 拿，不接受客户端传
//
// 幂等：dedupeKey 由 userId + entityType + entityId + ISO week 拼出；
// product_events.dedupeKey 是 @unique，重复请求会被 Prisma 抛 P2002 → 返回 200 + 已有事件。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { DetailReadCompletedInput } from '@deep-research/shared/schemas';
import { PRODUCT_EVENT_NAME } from '@deep-research/shared/metrics';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { requireUser } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { log, withRequestId } from '../../../../lib/log';
import { prisma } from '../../../../lib/db';

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const body = await parseBody(req, DetailReadCompletedInput);
  if (body instanceof NextResponse) return body;

  // 服务端强制覆盖：eventName / userId / occurredAt —— 客户端任何尝试都被忽略
  const eventName = PRODUCT_EVENT_NAME.DETAIL_READ_COMPLETED;
  const userId = u.id;
  const occurredAt = new Date();
  const isoWeek = isoWeekOf(occurredAt);
  const dedupeKey = `${userId}:${body.entityType}:${body.entityId}:${isoWeek}`;

  // 强制再校验：zod 已 min(30) / min(50)；这里防御性 double-check（万一 schema 被改）
  if (body.foregroundSeconds < 30 || body.scrollPercent < 50) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '阅读事件未满足双条件（≥30s 前台 + ≥50% 滚动）',
      requestId,
      details: {
        foregroundSeconds: body.foregroundSeconds,
        scrollPercent: body.scrollPercent,
      },
    });
  }

  try {
    await prisma.productEvent.create({
      data: {
        userId,
        eventName,
        entityType: body.entityType,
        entityId: body.entityId,
        metadata: {
          foregroundSeconds: body.foregroundSeconds,
          scrollPercent: body.scrollPercent,
          isoWeek,
        },
        dedupeKey,
        occurredAt,
      },
    });
  } catch (err) {
    // P2002 = dedupeKey 命中 —— 当前周已记录；返回 200 + ok:false 让客户端停止重试
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = (err as any)?.code as string | undefined;
    if (code === 'P2002') {
      log.info('events.detail-read', 'duplicate (already counted this week)', {
        requestId,
        userId,
        dedupeKey,
      });
      return NextResponse.json({ ok: false, deduplicated: true, dedupeKey });
    }
    throw err;
  }

  log.info('events.detail-read', 'ok', {
    requestId,
    userId,
    eventName,
    entityType: body.entityType,
    entityId: body.entityId,
  });

  return NextResponse.json({
    ok: true,
    event: {
      eventName,
      entityType: body.entityType,
      entityId: body.entityId,
      occurredAt: occurredAt.toISOString(),
    },
  });
});

/** ISO 8601 week number, e.g. "2026-W29"。 */
function isoWeekOf(d: Date): string {
  // Copy date, set to nearest Thursday: current date + 4 - current day number
  // Make Sunday = 7 (per ISO)
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// quiet linter
