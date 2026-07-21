// BFF handler: 单条摘要详情。
//
// 契约源：
//   - apps/web/prisma/schema.prisma: Summary
//   - docs/contracts/state-machines.md §4: 仅 published 摘要可被非 owner 读取
//     （P0 阶段 published 摘要对全员可见；sharedByUserId 仅用于追踪不参与权限）
//
// 入参: URL 段为 summary uuid。出参: 完整摘要字段（body 完整、tags、url 等）。
// 客户端详情页基于此渲染 + 触发 detail_read_completed 指标（见 /api/events/detail-read）。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../lib/db.js';
import { apiHandler } from '../../../../lib/api-handler.js';
import { toApiErrorResponse } from '../../../../lib/errors.js';
import { withRequestId } from '../../../../lib/log.js';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { SUMMARY_STATUS } from '@deep-research/shared/states';

const IdParam = z.object({ id: z.string().uuid() });

export const GET = apiHandler<[NextRequest, { params: { id: string } }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const parsed = IdParam.safeParse(ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const summary = await prisma.summary.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      title: true,
      body: true,
      url: true,
      tags: true,
      contentOrigin: true,
      summaryDate: true,
      publishedAt: true,
      createdAt: true,
      source: true,
      status: true,
      sharedBy: { select: { id: true, name: true, email: true } },
    },
  });

  if (!summary || summary.status !== SUMMARY_STATUS.PUBLISHED) {
    // 404：避免泄露已归档 / rejected / candidate 的存在性
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '摘要不存在或未发布',
      requestId,
    });
  }

  return NextResponse.json({
    id: summary.id,
    title: summary.title,
    body: summary.body,
    url: summary.url,
    tags: summary.tags,
    contentOrigin: summary.contentOrigin,
    summaryDate: summary.summaryDate.toISOString().slice(0, 10),
    publishedAt: summary.publishedAt ? summary.publishedAt.toISOString() : null,
    crawledAt: summary.createdAt.toISOString(),
    source: summary.source,
    sharedBy: summary.sharedBy
      ? {
          id: summary.sharedBy.id,
          name: summary.sharedBy.name,
        }
      : null,
  });
});
