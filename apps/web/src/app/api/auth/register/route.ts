import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { prisma } from '@/lib/db';
import { getWebEnv } from '@/lib/env';
import { isBootstrapAdminEmail } from '@/lib/auth/invitation';
import { canCreateAccountInBeta } from '@/lib/auth/beta-access';
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/auth/password';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { isProductionAuthAllowed } from '@/lib/auth/transport';
import {
  hashVerificationCode,
  verificationCodeMatches,
  VERIFICATION_MAX_ATTEMPTS,
} from '@/lib/auth/email-verification';

export const runtime = 'nodejs';

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().max(80).optional(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  verificationCode: z.string().regex(/^\d{6}$/).optional(),
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

  const { email, name, password, verificationCode } = parsed.data;
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
  if (!canCreateAccountInBeta({
    betaMode: env.AUTH_BETA_MODE,
    email,
    existingUser: existing,
    bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL,
  })) {
    return error(
      request,
      ERROR_CODES.AUTH_REGISTRATION_DISABLED,
      '当前为 Beta 测试，仅限管理员白名单中的邮箱注册',
    );
  }

  let verifiedCodeHash: string | null = null;
  if (env.AUTH_EMAIL_VERIFICATION) {
    if (!verificationCode) {
      return error(request, ERROR_CODES.AUTH_VERIFICATION_INVALID, '请输入 6 位邮箱验证码');
    }
    const challenge = await prisma.emailVerificationChallenge.findUnique({ where: { email } });
    if (!challenge || challenge.consumedAt || challenge.attempts >= VERIFICATION_MAX_ATTEMPTS) {
      return error(request, ERROR_CODES.AUTH_VERIFICATION_INVALID, '验证码无效，请重新获取');
    }
    if (challenge.expiresAt.getTime() <= Date.now()) {
      return error(request, ERROR_CODES.AUTH_VERIFICATION_EXPIRED, '验证码已过期，请重新获取');
    }
    verifiedCodeHash = hashVerificationCode(email, verificationCode, env.NEXTAUTH_SECRET);
    if (!verificationCodeMatches(verifiedCodeHash, challenge.codeHash)) {
      await prisma.emailVerificationChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null, attempts: { lt: VERIFICATION_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      return error(request, ERROR_CODES.AUTH_VERIFICATION_INVALID, '验证码无效，请检查后重试');
    }
  }

  const passwordHash = await hashPassword(password);
  const isBootstrapAdmin = isBootstrapAdminEmail(email, env.BOOTSTRAP_ADMIN_EMAIL);
  try {
    const persistUser = async (db: Pick<typeof prisma, 'user'>) => existing
      ? db.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          ...(name ? { name } : {}),
          ...(isBootstrapAdmin ? { role: 'admin' as const } : {}),
        },
        select: { id: true, role: true },
      })
      : db.user.create({
        data: {
          email,
          name: name || email.split('@')[0]!.slice(0, 80),
          passwordHash,
          role: isBootstrapAdmin ? 'admin' as const : 'member' as const,
        },
        select: { id: true, role: true },
      });

    const user = env.AUTH_EMAIL_VERIFICATION && verifiedCodeHash
      ? await prisma.$transaction(async (tx) => {
        const consumed = await tx.emailVerificationChallenge.updateMany({
          where: {
            email,
            codeHash: verifiedCodeHash!,
            consumedAt: null,
            expiresAt: { gt: new Date() },
            attempts: { lt: VERIFICATION_MAX_ATTEMPTS },
          },
          data: { consumedAt: new Date() },
        });
        if (consumed.count !== 1) throw new VerificationRaceError();
        return persistUser(tx);
      })
      : await persistUser(prisma);

    return NextResponse.json(
      { ok: true, role: user.role },
      { status: existing ? 200 : 201 },
    );
  } catch (cause) {
    if (cause instanceof VerificationRaceError) {
      return error(request, ERROR_CODES.AUTH_VERIFICATION_INVALID, '验证码已使用或已失效，请重新获取');
    }
    if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
      return error(request, ERROR_CODES.AUTH_ACCOUNT_EXISTS, '该邮箱已注册，请直接登录');
    }
    throw cause;
  }
}

class VerificationRaceError extends Error {}

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
