import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler } from '@/lib/api-handler';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { maskEmail } from '@/lib/mask-email';
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
  const isAdmin = user.role === 'admin';
  const rows = await prisma.user.findMany({
    where: {
      disabledAt: null,
      id: { not: user.id },
      // 非 admin 不能按邮箱搜索，否则可作为“邮箱是否存在”的探测口。
      ...(q
        ? {
            OR: isAdmin
              ? [{ name: { contains: q, mode: 'insensitive' as const } }, { email: { contains: q, mode: 'insensitive' as const } }]
              : [{ name: { contains: q, mode: 'insensitive' as const } }],
          }
        : {}),
    },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
    take: 20,
    select: { id: true, name: true, email: true, avatarUrl: true },
  });

  return NextResponse.json({
    items: isAdmin ? rows : rows.map((row) => ({ ...row, email: maskEmail(row.email) })),
  });
});
