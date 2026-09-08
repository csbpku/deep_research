// ADR 0010: 统一产品事件写入 helper。
//
// 元数据只保存 ID、数量、目标类型和来源入口；不存正文 / Prompt / URL 参数。
// 失败不抛错（事件不应阻塞主链路）；可在日志中观察失败率。

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

export const PRODUCT_EVENT = {
  TOPIC_FOLLOWED: 'topic_followed',
  TOPIC_UNFOLLOWED: 'topic_unfollowed',
  TOPIC_ISSUE_VIEWED: 'topic_issue_viewed',
  TOPIC_VIEWED_WITH_UNREAD: 'topic_viewed_with_unread',
  TOPIC_RESEARCH_STARTED: 'topic_research_started',
  RESEARCH_PLAN_CONFIRMED: 'research_plan_confirmed',
  RESEARCH_CONTEXT_REUSED: 'research_context_reused',
  RESEARCH_DRAFT_OPENED: 'research_draft_opened',
  RESEARCH_REOPENED_FROM_TOPIC: 'research_reopened_from_topic',
} as const;

export type ProductEventName = (typeof PRODUCT_EVENT)[keyof typeof PRODUCT_EVENT];

export interface RecordProductEventInput {
  userId: string;
  eventType: ProductEventName;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
}

/** Return the ISO calendar week used for low-frequency product-event dedupe. */
export function isoWeekOf(date = new Date()): string {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(
    ((value.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${value.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

/**
 * Build a stable key for events that should be counted at most once per
 * user/entity/week, such as reopening the same draft from several screens.
 */
export function buildWeeklyProductEventDedupeKey(input: {
  userId: string;
  eventType: ProductEventName;
  targetType?: string;
  targetId?: string;
  date?: Date;
}): string {
  return [
    input.userId,
    input.eventType,
    input.targetType ?? '',
    input.targetId ?? '',
    isoWeekOf(input.date),
  ].join(':').slice(0, 255);
}

function buildDedupeKey(input: RecordProductEventInput): string {
  if (input.dedupeKey) return input.dedupeKey.slice(0, 255);
  const stamp = Math.floor(Date.now() / 60000);
  return `${input.userId}:${input.eventType}:${input.targetId ?? ''}:${stamp}`.slice(0, 255);
}

export async function recordProductEvent(input: RecordProductEventInput): Promise<void> {
  try {
    const data = {
      userId: input.userId,
      eventName: input.eventType,
      entityType: input.targetType ?? null,
      entityId: input.targetId ?? null,
      metadata: input.metadata
        ? (input.metadata as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      dedupeKey: buildDedupeKey(input),
    };
    const productEventClient = (prisma as unknown as {
      productEvent?: {
        createMany?: (args: {
          data: typeof data[];
          skipDuplicates: boolean;
        }) => Promise<unknown>;
        create?: (args: { data: typeof data }) => Promise<unknown>;
      };
    }).productEvent;
    if (!productEventClient) return;

    const createMany = productEventClient.createMany;
    if (createMany) {
      await createMany({
        data: [data],
        skipDuplicates: true,
      });
    } else if (productEventClient.create) {
      // Keep lightweight route mocks and older generated clients usable.
      await productEventClient.create({ data });
    }
  } catch (err) {
    /* 事件不应阻塞主请求；幂等命中由 createMany skipDuplicates 静默处理。 */
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[product-events] record failed', input.eventType, err);
    }
  }
}
