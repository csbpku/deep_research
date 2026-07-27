// BFF handler: GET /api/imports/[id] — 查询导入任务状态
//
// 验收: 可看到 queued/running/succeeded/failed；成功后查看 warnings 和私有草稿
// 权限: 仅 requester 可查看自己的 job

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../lib/db';
import { apiHandler } from '../../../../lib/api-handler';
import { requireUser } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';

const IdParam = z.object({ id: z.string().uuid() });

export const GET = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const parsed = IdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const job = await prisma.contentImportJob.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      requesterId: true,
      status: true,
      sourceKind: true,
      originalFilename: true,
      mimeType: true,
      sizeBytes: true,
      contentSha256: true,
      warnings: true,
      errorCode: true,
      errorMessage: true,
      outputResearchId: true,
      attempts: true,
      createdAt: true,
      completedAt: true,
    },
  });

  if (!job) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '导入任务不存在',
      requestId,
    });
  }

  // 权限：仅 requester 可查看
  if (job.requesterId !== u.id && u.role !== 'admin') {
    return toApiErrorResponse({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: '只能查看自己的导入任务',
      requestId,
    });
  }

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    sourceKind: job.sourceKind,
    filename: job.originalFilename,
    mimeType: job.mimeType,
    sizeBytes: job.sizeBytes ? Number(job.sizeBytes) : null,
    contentSha256: job.contentSha256,
    warnings: job.warnings,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    outputResearchId: job.outputResearchId,
    attempts: job.attempts,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  });
});
