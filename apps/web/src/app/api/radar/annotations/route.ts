// BFF handler: create a radar text-selection annotation on a summary's
// originalMarkdown. Phase 3.a — inline highlight + comment.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { prisma } from '../../../../lib/db';
import { requireUser } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';

const CreateAnnotationInput = z.object({
  summaryId: z.string().uuid(),
  kind: z.enum(['highlight', 'comment', 'highlight_comment']),
  quote: z.string().min(1).max(4000),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
  body: z.string().max(2000).optional(),
  color: z.string().max(16).optional(),
}).strict();

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const input = await parseBody(req, CreateAnnotationInput);
  if (input instanceof NextResponse) return input;

  // Only published summaries are annotatable
  const seed = await prisma.summary.findUnique({
    where: { id: input.summaryId },
    select: { id: true, status: true },
  });
  if (!seed || seed.status !== 'published') {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_CHAT_FORBIDDEN_SEED,
      message: '该摘要不可注释',
      requestId,
    });
  }

  // Dedup: same (summary, author, quote, kind) is idempotent
  const existing = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM radar_annotations
      WHERE "summaryId" = $1 AND "authorId" = $2
        AND "quote" = $3 AND kind = $4
      LIMIT 1`,
    input.summaryId, user.id, input.quote, input.kind,
  );
  if (existing.length) {
    return NextResponse.json({ id: existing[0]!.id }, { status: 200 });
  }

  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO radar_annotations ("summaryId", "authorId", kind, quote, "startOffset", "endOffset", body, color)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id`,
    input.summaryId, user.id, input.kind, input.quote,
    input.startOffset, input.endOffset,
    input.body ?? null, input.color ?? null,
  );
  return NextResponse.json({ id: rows[0]!.id }, { status: 201 });
});

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const summaryId = url.searchParams.get('summaryId');
  if (!summaryId) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'missing summaryId',
      requestId,
    });
  }

  const annotations = await prisma.$queryRawUnsafe<
    { id: string; kind: string; quote: string; "startOffset": number; "endOffset": number; body: string | null; color: string | null; "createdAt": string; author_name: string; stars: number }[]
  >(
    `SELECT a.id, a.kind, a.quote, a."startOffset", a."endOffset", a.body, a.color,
            a."createdAt"::text, u.name AS author_name,
            (SELECT count(*) FROM radar_annotation_stars s WHERE s."annotationId" = a.id)::int AS stars
      FROM radar_annotations a JOIN users u ON u.id = a."authorId"
      WHERE a."summaryId" = $1
      ORDER BY a."createdAt" DESC
      LIMIT 200`,
    summaryId,
  );
  return NextResponse.json({ annotations });
});
