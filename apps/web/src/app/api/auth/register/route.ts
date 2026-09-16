import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { prisma } from '@/lib/db';
import { getWebEnv } from '@/lib/env';
import { isBootstrapAdminEmail } from '@/lib/auth/invitation';
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/auth/password';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { isProductionAuthAllowed } from '@/lib/auth/transport';

export const runtime = 'nodejs';

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().max(80).optional(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

export async function POST(request: Request) {
  const env = getWebEnv();
  if (env.AUTH_GOOGLE_ONLY) {
    return error(request, ERROR_CODES.AUTH_REGISTRATION_DISABLED, '当前部署仅允许使用 Google 登录');
  }
  if (!isProductionAuthAllowed(request.headers, env.NODE_ENV, request.url, env.AUTH_ALLOW_INSECURE_HTTP)) {
    return error(request, ERROR_CODES.AUTH_REQUIRES_HTTPS, '生产环境必须通过 HTTPS 注册账号');
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return error(request, ERROR_CODES.VALIDATION_FAILED, '请求格式无效');
  }

  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return error(
      request,
      ERROR_CODES.VALIDATION_FAILED,
      `邮箱格式无效，密码至少 ${PASSWORD_MIN_LENGTH} 个字符`,
    );
  }

  const { email, name, password } = parsed.data;
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, disabledAt: true },
  });

  if (existing?.disabledAt) {
    return error(request, ERROR_CODES.AUTH_ACCOUNT_DISABLED, '该账号已被禁用');
  }
  if (existing?.passwordHash) {
    return error(request, ERROR_CODES.AUTH_ACCOUNT_EXISTS, '该邮箱已注册，请直接登录');
  }

  const passwordHash = await hashPassword(password);
  const isBootstrapAdmin = isBootstrapAdminEmail(email, env.BOOTSTRAP_ADMIN_EMAIL);
  try {
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            passwordHash,
            ...(name ? { name } : {}),
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
      return error(request, ERROR_CODES.AUTH_ACCOUNT_EXISTS, '该邮箱已注册，请直接登录');
    }
    throw cause;
  }
}

export function GET() {
  return NextResponse.json(
    { ok: false, code: 'METHOD_NOT_ALLOWED' },
    { status: 405 },
  );
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
