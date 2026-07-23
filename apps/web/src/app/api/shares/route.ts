// BFF handler: POST /api/shares — 用户分享 URL 入口。
//
// 契约源：
//   - docs/contracts/fetch-url-safety.md  安全抓取器契约
//   - packages/shared/src/schemas.ts      ShareUrlInput
//   - apps/web/prisma/schema.prisma       share_submissions
//
// 请求：POST /api/shares  {"url":"...","userNote":"..."}
// 实现：zod 校验 → 写 share_submissions(status='pending') → 返回 jobId 与状态
//      worker（在 packages/ai-engine）后续 acquire → safe_fetch → adapter
//      .summary_brief → UPDATE share_submissions (fetchedMarkdown 等)
//
// 权限：requireUser。返回不暴露 raw 文本；worker 只生成 Markdown 写 DB。
//      创建同 (user, canonicalUrl) + status=pending → 409 DUPLICATE 直接返回已有 job。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../lib/db';
import { apiHandler, parseBody } from '../../../lib/api-handler';
import { requireUser } from '../../../lib/auth/session';
import { toApiErrorResponse } from '../../../lib/errors';
import { log, withRequestId } from '../../../lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';

/** BFF 校验：与 packages/shared/src/schemas.ts::ShareUrlInput 对齐 */
import { z } from 'zod';

const CreateShareInput = z.object({
  url: z.string().url().max(2048),
  userNote: z.string().max(500).optional(),
});

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const body = await parseBody(req, CreateShareInput);
  if (body instanceof NextResponse) return body;

  // 规范化 canonical URL：去掉 #fragment 和 tracking params
  const canonicalUrl = stripTracking(body.url);

  // 幂等：同 (user, canonical URL) 已 pending → 409 + 返回已有 job
  const existing = await (prisma as any).shareSubmission.findFirst({
    where: {
      submitterId: u.id,
      canonicalUrl,
      status: 'pending',
    },
    select: { id: true, status: true, createdAt: true },
  });

  if (existing) {
    log.info('api.shares', 'duplicate pending share', {
      requestId,
      userId: u.id,
      canonicalUrl,
      existingJobId: existing.id,
    });
    return NextResponse.json(
      {
        jobId: existing.id,
        status: existing.status,
        createdAt: existing.createdAt.toISOString(),
        duplicate: true,
      },
      { status: 409 },
    );
  }

  // 写 share_submissions 行；worker 后续 acquire 并填充 fetchedMarkdown / summaryText
  const submission = await (prisma as any).shareSubmission.create({
    data: {
      submitterId: u.id,
      url: body.url,
      canonicalUrl,
      userNote: body.userNote ?? null,
      status: 'pending',
    },
    select: { id: true, status: true, createdAt: true },
  });

  log.info('api.shares', 'share submission created', {
    requestId,
    userId: u.id,
    jobId: submission.id,
    canonicalUrl,
    hasNote: Boolean(body.userNote),
  });

  return NextResponse.json(
    {
      jobId: submission.id,
      status: submission.status,
      createdAt: submission.createdAt.toISOString(),
    },
    { status: 202 },
  );
});

/** 剥掉 fragment 和常见 tracking params（utm_*, ref, source 等） */
function stripTracking(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  url.hash = '';
  const trackingKeys = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'ref', 'source', 'fbclid', 'gclid', 'gclsrc', 'dclid',
    '_ga', '_gl', 'mc_cid', 'mc_eid',
  ];
  for (const k of trackingKeys) url.searchParams.delete(k);
  return url.href;
}
