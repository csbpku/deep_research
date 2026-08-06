// 调研库状态/精选变更的事务写入，供 owner 与 admin 路由共用。

import { RESEARCH_STATUS } from '@deep-research/shared/states';
import { ADMIN_TARGET_TYPE, writeAdminAction } from './radar/admin-actions';
import type { TxClient } from './radar/tx';

export type ResearchStatusAction = 'archive' | 'restore';

export interface ResearchStatusTransitionOptions {
  id: string;
  actorId: string;
  action: ResearchStatusAction;
  adminAction?: {
    action: string;
    requestId: string;
  };
}

export async function transitionResearchStatus(
  tx: TxClient,
  options: ResearchStatusTransitionOptions,
): Promise<{
  id: string;
  status: string;
  updatedAt: Date;
  actionRequestId: string | null;
}> {
  const existing = await tx.research.findUnique({
    where: { id: options.id },
    select: { id: true, status: true, publishedAt: true },
  });
  if (!existing) {
    throw new Error('RESEARCH_NOT_FOUND');
  }

  const isArchive = options.action === 'archive';
  if (isArchive && existing.status !== RESEARCH_STATUS.PUBLISHED) {
    throw new Error('INVALID_ARCHIVE_STATE');
  }
  if (!isArchive && existing.status !== RESEARCH_STATUS.ARCHIVED) {
    throw new Error('INVALID_RESTORE_STATE');
  }

  const updated = await tx.research.update({
    where: { id: existing.id },
    data: isArchive
      ? { status: RESEARCH_STATUS.ARCHIVED }
      : {
          status: RESEARCH_STATUS.PUBLISHED,
          publishedAt: existing.publishedAt ?? new Date(),
        },
    select: { id: true, status: true, updatedAt: true },
  });

  await tx.researchAudit.create({
    data: {
      researchId: existing.id,
      editorId: options.actorId,
      action: options.action,
    },
  });

  let actionRequestId: string | null = null;
  if (options.adminAction) {
    actionRequestId = options.adminAction.requestId;
    await writeAdminAction(tx, {
      actorId: options.actorId,
      action: options.adminAction.action,
      targetType: ADMIN_TARGET_TYPE.RESEARCH,
      targetId: existing.id,
      requestId: actionRequestId,
      metadata: { previousStatus: existing.status },
    });
  }

  return { ...updated, actionRequestId };
}

export async function setResearchFeatured(
  tx: TxClient,
  options: {
    id: string;
    actorId: string;
    featured: boolean;
    adminAction?: {
      action: string;
      requestId: string;
    };
  },
): Promise<{
  id: string;
  featuredAt: Date | null;
  updatedAt: Date;
  actionRequestId: string | null;
}> {
  const existing = await tx.research.findUnique({
    where: { id: options.id },
    select: { id: true, status: true },
  });
  if (!existing) {
    throw new Error('RESEARCH_NOT_FOUND');
  }
  if (existing.status !== RESEARCH_STATUS.PUBLISHED) {
    throw new Error('INVALID_FEATURE_STATE');
  }

  const updated = await tx.research.update({
    where: { id: existing.id },
    data: { featuredAt: options.featured ? new Date() : null },
    select: { id: true, featuredAt: true, updatedAt: true },
  });

  await tx.researchAudit.create({
    data: {
      researchId: existing.id,
      editorId: options.actorId,
      action: options.featured ? 'feature' : 'unfeature',
    },
  });

  let actionRequestId: string | null = null;
  if (options.adminAction) {
    actionRequestId = options.adminAction.requestId;
    await writeAdminAction(tx, {
      actorId: options.actorId,
      action: options.adminAction.action,
      targetType: ADMIN_TARGET_TYPE.RESEARCH,
      targetId: existing.id,
      requestId: actionRequestId,
      metadata: { featured: options.featured },
    });
  }

  return { ...updated, actionRequestId };
}
