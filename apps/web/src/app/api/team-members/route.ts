import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler } from '@/lib/api-handler';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';

const TeamMemberQuery = z.object({ q: z.string().trim().max(80).default('') });

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const parsed = TeamMemberQuery.safeParse({ q: new URL(req.url).searchParams.get('q') ?? '' });
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '搜索条件不合法',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const q = parsed.data.q;
  const items = await prisma.user.findMany({
    where: {
      disabledAt: null,
      id: { not: user.id },
      ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] } : {}),
    },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
    take: 20,
    select: { id: true, name: true, email: true, avatarUrl: true },
  });

  return NextResponse.json({ items });
});
