// BFF handler: POST/GET /api/radar/submissions — 提交 URL 候选 / 查询当前用户历史。
//
// 返回字段：id / status / detectedKind / canonicalUrl|contentSha256 / createdAt / completedAt / summaryId / errorCode
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { withRequestId } from '@/lib/log';
import { toApiErrorResponse } from '@/lib/errors';
import {
  detectUrlKind,
  isLikelySafeUrl,
} from '@/lib/radar/submissions/detect';
import { enqueueRadarSubmission } from '@/lib/radar/submissions/worker-bridge';
import { ERROR_CODES } from '@deep-research/shared/errors';

const PAGE_SIZE = 20;

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const requestId = withRequestId(req.headers);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '请输入有效的 URL',
      requestId,
    });
  }

  const rawInput =
    typeof raw === 'object' && raw !== null && typeof (raw as { rawInput?: unknown }).rawInput === 'string'
      ? (raw as { rawInput: string }).rawInput.trim()
      : '';
  if (!rawInput || rawInput.length > 2048) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '请输入 1–2048 个字符的 URL',
      requestId,
    });
  }

  const safety = isLikelySafeUrl(rawInput);
  if (!safety.ok) {
    return toApiErrorResponse({
      code: ERROR_CODES.URL_FETCH_BLOCKED,
      message: safety.reason,
      requestId,
    });
  }
  const detected = detectUrlKind(rawInput);
  if (!detected) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '仅支持 http(s) URL',
      requestId,
    });
  }

  const existing = await prisma.radarSubmission.findFirst({
    where: {
      submitterId: user.id,
      canonicalUrl: detected.canonicalUrl,
      status: { notIn: ['completed', 'duplicate', 'failed'] },
    },
    select: { id: true, status: true },
  });
  if (existing) {
    return NextResponse.json(
      {
        code: 'RADAR_SUBMISSION_DUPLICATE_ACTIVE',
        message: '该 URL 已在处理中',
        submissionId: existing.id,
        status: existing.status,
        requestId,
      },
      { status: 409 },
    );
  }

  const created = await prisma.radarSubmission.create({
    data: {
      submitterId: user.id,
      kind: detected.kind,
      rawInput,
      canonicalUrl: detected.canonicalUrl,
      detectedKind: detected.kind,
      status: 'type_detected',
    },
    select: {
      id: true,
      status: true,
      detectedKind: true,
      rawInput: true,
      canonicalUrl: true,
      contentSha256: true,
      summaryId: true,
      errorCode: true,
      errorMessage: true,
      createdAt: true,
      completedAt: true,
    },
  });

  // DB row is the durable queue. This call only nudges the worker state and
  // must not turn a successfully accepted submission into an HTTP failure.
  void enqueueRadarSubmission(created.id).catch((err) => {
    console.error('[radar-submission] enqueue failed', { id: created.id, err });
  });

  return NextResponse.json(
    {
      ok: true,
      submission: {
        ...created,
        createdAt: created.createdAt.toISOString(),
        completedAt: created.completedAt?.toISOString() ?? null,
      },
      requestId,
    },
    { status: 202 },
  );
});

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const requestId = withRequestId(req.headers);

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const status = url.searchParams.get('status');

  const where = {
    submitterId: user.id,
    ...(status ? { status: status as never } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.radarSubmission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        kind: true,
        detectedKind: true,
        status: true,
        rawInput: true,
        canonicalUrl: true,
        contentSha256: true,
        summaryId: true,
        errorCode: true,
        errorMessage: true,
        createdAt: true,
        completedAt: true,
      },
    }),
    prisma.radarSubmission.count({ where }),
  ]);

  return NextResponse.json({
    page,
    perPage: PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    items: items.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
      completedAt: s.completedAt?.toISOString() ?? null,
    })),
    requestId,
  });
});
