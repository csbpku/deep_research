// Admin actions 写入 + 候选更新公用 helper。
//
// 契约源：
//   - apps/web/prisma/schema.prisma: AdminAction / Summary
//   - docs/agent-prompts/week5-engineer-a.md §任务 3
//
// 所有 Admin 操作必须写一条 AdminAction 审计行（actor + action + target +
// requestId + metadata）。失败时整事务回滚，避免状态错位。

import type { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { TxClient } from './tx';

export const ADMIN_TARGET_TYPE = {
  RADAR_SUMMARY: 'radar_summary',
} as const;
export type AdminTargetType = (typeof ADMIN_TARGET_TYPE)[keyof typeof ADMIN_TARGET_TYPE];

export const ADMIN_RADAR_ACTIONS = {
  SELECT: 'radar_select',
  DISMISS: 'radar_dismiss',
  RETRY_INTERPRETATION: 'radar_retry_interpretation',
  CREATE_RESEARCH: 'radar_create_research',
} as const;
export type AdminRadarAction = (typeof ADMIN_RADAR_ACTIONS)[keyof typeof ADMIN_RADAR_ACTIONS];

/** 通用审计写入：actor / action / target / metadata + requestId（unique）。 */
export async function writeAdminAction(
  tx: TxClient | PrismaClient,
  args: {
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    requestId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ id: string; requestId: string }> {
  const row = await tx.adminAction.create({
    data: {
      actorId: args.actorId,
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      requestId: args.requestId,
      metadata: (args.metadata ?? {}) as Prisma.InputJsonValue,
    },
    select: { id: true, requestId: true },
  });
  return row;
}

/** 用 randomUUID 生成一个新 requestId（admin_actions.requestId unique）。 */
export function newAdminActionRequestId(): string {
  return randomUUID();
}