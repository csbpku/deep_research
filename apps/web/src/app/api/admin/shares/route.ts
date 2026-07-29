// BFF handler: GET /api/admin/shares — Admin 用户分享审核队列。
//
// 契约源：apps/web/prisma/schema.prisma::shareSubmissions
// 入参: ?status=pending|approved|rejected（默认 pending）&page=&per_page=
// 出参: items[] 含 submitter 信息 + 抓取摘要 + 状态

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../lib/db';
import { apiHandler } from '../../../../lib/api-handler';
import { requireAdmin } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';
import { AdminShareListQuery } from '../../../../lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const url = new URL(req.url);
  const parsed = AdminShareListQuery.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    page: url.searchParams.get('page') ?? undefined,
    per_page: url.searchParams.get('per_page') ?? undefined,
  });
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '查询参数错误',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { status, page, per_page: perPage } = parsed.data;

  const where: Prisma.ShareSubmissionWhereInput = status ? { status } : { status: 'pending' };

  const [items, total] = await Promise.all([
    prisma.shareSubmission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        url: true,
        canonicalUrl: true,
        userNote: true,
        fetchedTitle: true,
        summaryText: true,
        fetchErrorCode: true,
        fetchErrorMessage: true,
        status: true,
        createdAt: true,
        completedAt: true,
        submitter: { select: { id: true, name: true, email: true } },
        reviewer: { select: { id: true, name: true } },
      },
    }),
    prisma.shareSubmission.count({ where }),
  ]);

  return NextResponse.json({
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
    items: items.map((it) => ({
      id: it.id,
      url: it.url,
      canonicalUrl: it.canonicalUrl,
      userNote: it.userNote,
      fetchedTitle: it.fetchedTitle,
      summaryText: it.summaryText,
      fetchErrorCode: it.fetchErrorCode,
      fetchErrorMessage: it.fetchErrorMessage,
      status: it.status,
      createdAt: it.createdAt.toISOString(),
      completedAt: it.completedAt?.toISOString() ?? null,
      submitter: it.submitter,
      reviewer: it.reviewer,
    })),
  });
});