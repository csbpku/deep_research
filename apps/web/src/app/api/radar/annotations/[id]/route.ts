// BFF handler: update / delete one of the current user's radar annotations.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler, parseBody } from '../../../../../lib/api-handler';
import { prisma } from '../../../../../lib/db';
import { requireUser } from '../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { withRequestId } from '../../../../../lib/log';

const AnnotationIdParam = z.object({ id: z.string().uuid() });

const UpdateAnnotationInput = z.object({
  body: z.string().max(2000).optional(),
  color: z.string().max(16).optional(),
}).strict();

export const PATCH = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const idParsed = AnnotationIdParam.safeParse(await ctx.params);
  if (!idParsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: idParsed.error.flatten(),
    });
  }

  const input = await parseBody(req, UpdateAnnotationInput);
  if (input instanceof NextResponse) return input;
  if (input.body === undefined && input.color === undefined) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '至少提供 body 或 color 之一',
      requestId,
    });
  }

  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE radar_annotations
      SET body = COALESCE($2::text, body),
          color = COALESCE($3::text, color),
          "updatedAt" = now()
      WHERE id = $1::uuid AND "authorId" = $4::uuid
      RETURNING id`,
    idParsed.data.id, input.body ?? null, input.color ?? null, user.id,
  );
  if (!rows.length) {
    return toApiErrorResponse({
      code: ERROR_CODES.NOT_FOUND,
      message: '批注不存在',
      requestId,
    });
  }
  return NextResponse.json({ id: rows[0]!.id });
});

export const DELETE = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const idParsed = AnnotationIdParam.safeParse(await ctx.params);
  if (!idParsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: idParsed.error.flatten(),
    });
  }

  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `DELETE FROM radar_annotations
      WHERE id = $1::uuid AND "authorId" = $2::uuid
      RETURNING id`,
    idParsed.data.id, user.id,
  );
  if (!rows.length) {
    return toApiErrorResponse({
      code: ERROR_CODES.NOT_FOUND,
      message: '批注不存在',
      requestId,
    });
  }
  return NextResponse.json({ ok: true });
});
