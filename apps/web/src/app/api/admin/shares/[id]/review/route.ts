// BFF handler: POST /api/admin/shares/[id]/review — Admin 批准/拒绝用户分享。
//
// 批准：share_submissions.status = 'approved'，并发布为可见的雷达 Summary。
// 自动日报按统一评分与来源配额决定是否引用，无需 Admin 逐条选入。
// 拒绝：share_submissions.status = 'rejected'，reviewer + reviewedAt 写审计。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../../../lib/db';
import { apiHandler, parseBody } from '../../../../../../lib/api-handler';
import { requireAdmin } from '../../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../../lib/errors';
import { log, withRequestId } from '../../../../../../lib/log';
import { AdminShareReviewInput, SummaryIdParam } from '../../../../../../lib/schemas';
import { newAdminActionRequestId, writeAdminAction } from '../../../../../../lib/radar/admin-actions';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { SUMMARY_STATUS } from '@deep-research/shared/states';

const ADMIN_TARGET_TYPE = 'share_submission' as const;
const ADMIN_SHARE_ACTIONS = {
  APPROVE: 'share_approve',
  REJECT: 'share_reject',
} as const;

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const idParsed = SummaryIdParam.safeParse(await ctx.params);
  if (!idParsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: idParsed.error.flatten(),
    });
  }

  const body = await parseBody(req, AdminShareReviewInput);
  if (body instanceof NextResponse) return body;

  const share = await prisma.shareSubmission.findUnique({
    where: { id: idParsed.data.id },
    select: {
      id: true,
      status: true,
      url: true,
      canonicalUrl: true,
      userNote: true,
      fetchedTitle: true,
      fetchedMarkdown: true,
      summaryText: true,
      submitterId: true,
      contentSha256: true,
    },
  });
  if (!share) {
    return toApiErrorResponse({
      code: ERROR_CODES.NOT_FOUND,
      message: '分享不存在',
      requestId,
    });
  }
  if (share.status !== 'pending') {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '该分享已被处理',
      requestId,
    });
  }
  // 抓取失败的不允许批准（safe_fetch 没拿到正文，发布没有价值）
  if (body.action === 'approve' && !share.summaryText) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '分享未生成摘要，无法批准',
      requestId,
    });
  }

  const actionRequestId = newAdminActionRequestId();

  const result = await prisma.$transaction(async (tx) => {
    if (body.action === 'approve') {
      // 创建 candidate Summary 记录（不发布到每日摘要，需要后续雷达审核选入）
      const summary = await tx.summary.create({
        data: {
          title: share.fetchedTitle ?? share.url,
          body: share.summaryText ?? '',
          interpretation: share.summaryText ?? null,
          url: share.url,
          canonicalUrl: share.canonicalUrl,
          source: 'user',
          contentOrigin: 'web',
          userNote: share.userNote,
          sharedByUserId: share.submitterId,
          status: SUMMARY_STATUS.CANDIDATE,
          tags: [],
          // Summary.contentSha256 是 Char(64)；ShareSubmission 已经在 safe_fetch 时算过
          // contentSha256（同样 Char(64)），这里直接复用。如果 share 还没生成（老数据），置 null。
          contentSha256: share.contentSha256 ?? null,
          originalMarkdown: share.fetchedMarkdown ?? null,
          originalKind: 'web_share',
          originalFetchedAt: share.fetchedMarkdown ? new Date() : null,
          originalBytes: share.fetchedMarkdown
            ? Buffer.byteLength(share.fetchedMarkdown, 'utf8')
            : null,
          originalSha256: share.contentSha256 ?? null,
          summaryDate: new Date(),
        },
        select: { id: true },
      });

      // 关联 share → summary
      await tx.shareSubmission.update({
        where: { id: share.id },
        data: {
          status: 'approved',
          reviewerId: u.id,
          reviewedAt: new Date(),
          publishedSummaryId: summary.id,
        },
        select: { id: true },
      });

      await writeAdminAction(tx, {
        actorId: u.id,
        action: ADMIN_SHARE_ACTIONS.APPROVE,
        targetType: ADMIN_TARGET_TYPE,
        targetId: share.id,
        requestId: actionRequestId,
        metadata: { summaryId: summary.id },
      });

      return { summaryId: summary.id };
    }

    // reject
    await tx.shareSubmission.update({
      where: { id: share.id },
      data: { status: 'rejected', reviewerId: u.id, reviewedAt: new Date() },
      select: { id: true },
    });
    await writeAdminAction(tx, {
      actorId: u.id,
      action: ADMIN_SHARE_ACTIONS.REJECT,
      targetType: ADMIN_TARGET_TYPE,
      targetId: share.id,
      requestId: actionRequestId,
      metadata: { reason: body.reason },
    });
    return { summaryId: null };
  });

  log.info('admin.share.review', `share ${body.action}d`, {
    requestId,
    userId: u.id,
    shareId: share.id,
    actionRequestId,
    summaryId: result.summaryId,
  });

  return NextResponse.json({
    ok: true,
    action: body.action,
    summaryId: result.summaryId,
    actionRequestId,
  });
});
