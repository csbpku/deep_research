import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { prisma } from '../../../../lib/db';
import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { requireUser } from '../../../../lib/auth/session';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { toApiErrorResponse } from '../../../../lib/errors';

const Rating = z.enum(['got_it', 'unsure', 'missed']);

const Upsert = z.object({
  researchId: z.string().uuid(),
  questionKey: z.string().min(1).max(500),
  rating: Rating,
});

const ListQuery = z.object({ researchId: z.string().uuid() });

export const POST = apiHandler(async (request: NextRequest) => {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;
  const parsed = await parseBody(request, Upsert);
  if (parsed instanceof NextResponse) return parsed;
  const [research] = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM researches WHERE id = ${parsed.researchId}::uuid`;
  if (!research) {
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: '调研不存在', requestId: request.headers.get('x-request-id') || 'unknown' });
  }
  // Keep the weak interval's start atomically, including got_it -> weak and
  // concurrent re-ratings. A read followed by upsert can reset that clock.
  const [row] = await prisma.$queryRaw<Array<{
    id: string; rating: string; updatedAt: Date; firstMissedAt: Date | null;
  }>>`
    INSERT INTO "learning_self_check" ("userId", "researchId", "questionKey", "rating", "firstMissedAt", "updatedAt")
    VALUES (${user.id}::uuid, ${parsed.researchId}::uuid, ${parsed.questionKey}, ${parsed.rating},
      CASE WHEN ${parsed.rating} = 'got_it' THEN NULL ELSE CURRENT_TIMESTAMP END, CURRENT_TIMESTAMP)
    ON CONFLICT ("userId", "researchId", "questionKey") DO UPDATE SET
      "rating" = EXCLUDED."rating",
      "firstMissedAt" = CASE WHEN EXCLUDED."rating" = 'got_it' THEN NULL
        ELSE COALESCE("learning_self_check"."firstMissedAt", EXCLUDED."firstMissedAt") END,
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "id", "rating", "updatedAt", "firstMissedAt"`;
  if (!row) throw new Error('Self-check upsert returned no row');
  return NextResponse.json({ id: row.id, rating: row.rating, updatedAt: row.updatedAt, firstMissedAt: row.firstMissedAt });
});

export const GET = apiHandler(async (request: NextRequest) => {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = ListQuery.safeParse(query);
  if (!parsed.success) {
    return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: 'researchId 无效', requestId: request.headers.get('x-request-id') || 'unknown' });
  }
  const rows = await prisma.learningSelfCheck.findMany({
    where: { userId: user.id, researchId: parsed.data.researchId },
    select: { questionKey: true, rating: true },
  });
  return NextResponse.json({ ratings: Object.fromEntries(rows.map(row => [row.questionKey, row.rating])) });
});
