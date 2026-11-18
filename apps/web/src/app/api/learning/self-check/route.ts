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
  const existing = await prisma.learningSelfCheck.findUnique({
    where: { userId_researchId_questionKey: { userId: user.id, researchId: parsed.researchId, questionKey: parsed.questionKey } },
    select: { correctStreak: true, firstMissedAt: true },
  });
  // One correct answer is often a lucky guess. Retire the weak mark only on
  // the second consecutive "got it"; a wrong answer resets the streak.
  const correctStreak = parsed.rating === 'got_it' ? (existing?.correctStreak ?? 0) + 1 : 0;
  const retired = correctStreak >= 2;
  const row = await prisma.learningSelfCheck.upsert({
    where: { userId_researchId_questionKey: { userId: user.id, researchId: parsed.researchId, questionKey: parsed.questionKey } },
    create: {
      userId: user.id,
      researchId: parsed.researchId,
      questionKey: parsed.questionKey,
      rating: retired ? 'got_it' : parsed.rating,
      correctStreak,
      ...(parsed.rating === 'got_it' ? {} : { firstMissedAt: new Date() }),
    },
    update: {
      rating: retired ? 'got_it' : parsed.rating,
      correctStreak,
      ...(retired
        ? { firstMissedAt: null }
        : parsed.rating === 'got_it'
          ? {}
          : { firstMissedAt: existing?.firstMissedAt ?? new Date() }),
    },
  });
  return NextResponse.json({
    id: row.id,
    rating: row.rating,
    correctStreak: row.correctStreak,
    updatedAt: row.updatedAt,
    firstMissedAt: row.firstMissedAt,
  });
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
