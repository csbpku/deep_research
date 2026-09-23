// BFF handler: GET /api/admin/users + POST Beta registration allowlist.
//
// 设计：仅返回 id / email / name / role / createdAt / disabledAt。
// 给 Admin 控制台的「成员」tab 用来核对角色与禁用状态，Phase 1 不支持编辑。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { prisma } from '../../../../lib/db';
import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { requireAdmin } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
}).strict();

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, createdAt: true, disabledAt: true },
    orderBy: { createdAt: 'asc' },
  });
  return NextResponse.json({
    items: users.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
      disabledAt: row.disabledAt?.toISOString() ?? null,
    })),
  });
});

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const actor = await requireAdmin(req);
  if (actor instanceof NextResponse) return actor;
  const requestId = withRequestId(req.headers);
  const body = await parseBody(req, inviteSchema);
  if (body instanceof NextResponse) return body;

  const existing = await prisma.user.findUnique({
    where: { email: body.email },
    select: { id: true, email: true, disabledAt: true },
  });
  if (existing?.disabledAt) {
    return toApiErrorResponse({
      code: ERROR_CODES.AUTH_ACCOUNT_DISABLED,
      message: '该邮箱对应账号已被禁用，请先在成员列表中恢复',
      requestId,
    });
  }
  if (existing) {
    return NextResponse.json({ ok: true, noop: true, email: existing.email });
  }

  try {
    const invited = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: body.email,
          name: body.email.split('@')[0]!.slice(0, 80),
          role: 'member',
        },
        select: { id: true, email: true },
      });
      await tx.adminAction.create({
        data: {
          actorId: actor.id,
          action: 'user.beta_allowlist_add',
          targetType: 'user',
          targetId: user.id,
          requestId: crypto.randomUUID(),
          metadata: { email: user.email } as Prisma.JsonObject,
        },
      });
      return user;
    });
    return NextResponse.json({ ok: true, noop: false, email: invited.email }, { status: 201 });
  } catch (cause) {
    if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
      return NextResponse.json({ ok: true, noop: true, email: body.email });
    }
    throw cause;
  }
});
