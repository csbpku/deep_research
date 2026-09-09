import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { prisma } from '@/lib/db';
import { getWebEnv } from '@/lib/env';
import { isEmailAllowed } from '@/lib/auth/allowlist';
import { bootstrapAdminEmail, isInviteCodeValid } from '@/lib/auth/invitation';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/auth/password';

export const runtime = 'nodejs';

const activateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  inviteCode: z.string().trim().min(1).max(256),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  name: z.string().trim().max(80).optional(),
});

export async function POST(request: Request) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return error(request, ERROR_CODES.VALIDATION_FAILED, '请求格式无效');
  }

  const parsed = activateSchema.safeParse(input);
  if (!parsed.success) {
    return error(
      request,
      ERROR_CODES.VALIDATION_FAILED,
      `邮箱格式无效，邀请码不能为空，密码至少 ${PASSWORD_MIN_LENGTH} 个字符`,
    );
  }

  const { email, inviteCode, password, name } = parsed.data;
  const env = getWebEnv();
  if (!isEmailAllowed(email, env.ALLOWED_EMAIL_DOMAINS)) {
    return error(request, ERROR_CODES.AUTH_DOMAIN_NOT_ALLOWED, '该邮箱不在允许名单内');
  }
  if (!isInviteCodeValid(inviteCode, env.AUTH_INVITE_CODE)) {
    return error(request, ERROR_CODES.AUTH_INVITE_INVALID, '邀请码无效或已关闭');
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, disabledAt: true },
  });

  if (existing?.disabledAt) {
    return error(request, ERROR_CODES.AUTH_ACCOUNT_DISABLED, '该账号已被禁用');
  }
  if (existing?.passwordHash) {
    return error(request, ERROR_CODES.AUTH_ACCOUNT_EXISTS, '该邮箱已激活，请直接登录');
  }

  const passwordHash = await hashPassword(password);
  const isBootstrapAdmin = bootstrapAdminEmail(env.BOOTSTRAP_ADMIN_EMAIL) === email;
  try {
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            passwordHash,
            ...(isBootstrapAdmin ? { role: 'admin' } : {}),
          },
          select: { id: true, role: true },
        })
      : await prisma.user.create({
          data: {
            email,
            name: name || email.split('@')[0]!.slice(0, 80),
            passwordHash,
            role: isBootstrapAdmin ? 'admin' : 'member',
          },
          select: { id: true, role: true },
        });

    return NextResponse.json(
      { ok: true, role: user.role },
      { status: existing ? 200 : 201 },
    );
  } catch (cause) {
    if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
      return error(request, ERROR_CODES.AUTH_ACCOUNT_EXISTS, '该邮箱已激活，请直接登录');
    }
    throw cause;
  }
}

function error(
  request: Request,
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
) {
  return toApiErrorResponse({
    code,
    message,
    requestId: withRequestId(request.headers),
  });
}
