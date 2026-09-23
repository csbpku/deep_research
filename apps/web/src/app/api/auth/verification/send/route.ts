import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { prisma } from '@/lib/db';
import { getWebEnv } from '@/lib/env';
import { canCreateAccountInBeta } from '@/lib/auth/beta-access';
import { isProductionAuthAllowed } from '@/lib/auth/transport';
import {
  generateVerificationCode,
  hashVerificationCode,
  hashVerificationRequestIp,
  requestIp,
  VERIFICATION_MAX_SENDS_PER_IP_HOUR,
  VERIFICATION_RESEND_COOLDOWN_MS,
  VERIFICATION_TTL_MS,
} from '@/lib/auth/email-verification';
import { sendRegistrationVerificationEmail } from '@/lib/auth/verification-mailer';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';

export const runtime = 'nodejs';

const bodySchema = z.object({ email: z.string().trim().toLowerCase().email().max(320) }).strict();

export async function POST(request: Request) {
  const env = getWebEnv();
  if (!env.AUTH_EMAIL_VERIFICATION || env.AUTH_GOOGLE_ONLY) {
    return error(request, ERROR_CODES.AUTH_REGISTRATION_DISABLED, '当前未启用邮箱验证码注册');
  }
  if (!isProductionAuthAllowed(request.headers, env.NODE_ENV, request.url, env.AUTH_ALLOW_INSECURE_HTTP)) {
    return error(request, ERROR_CODES.AUTH_REQUIRES_HTTPS, '生产环境必须通过 HTTPS 请求验证码');
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return error(request, ERROR_CODES.VALIDATION_FAILED, '邮箱格式无效');
  const { email } = parsed.data;
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, disabledAt: true },
  });
  if (existing?.disabledAt) return error(request, ERROR_CODES.AUTH_ACCOUNT_DISABLED, '该账号已被禁用');
  if (existing?.passwordHash) return error(request, ERROR_CODES.AUTH_ACCOUNT_EXISTS, '该邮箱已注册，请直接登录');
  if (!canCreateAccountInBeta({
    betaMode: env.AUTH_BETA_MODE,
    email,
    existingUser: existing,
    bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL,
  })) {
    return error(request, ERROR_CODES.AUTH_REGISTRATION_DISABLED, '当前为 Beta 测试，仅限管理员白名单中的邮箱注册');
  }

  const now = new Date();
  const current = await prisma.emailVerificationChallenge.findUnique({ where: { email } });
  if (current && now.getTime() - current.sentAt.getTime() < VERIFICATION_RESEND_COOLDOWN_MS) {
    return error(request, ERROR_CODES.AUTH_VERIFICATION_RATE_LIMITED, '验证码发送过于频繁，请稍后再试');
  }
  const ipHash = hashVerificationRequestIp(requestIp(request.headers), env.NEXTAUTH_SECRET);
  const recentIpSends = await prisma.emailVerificationChallenge.count({
    where: { requestIpHash: ipHash, sentAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) } },
  });
  if (recentIpSends >= VERIFICATION_MAX_SENDS_PER_IP_HOUR) {
    return error(request, ERROR_CODES.AUTH_VERIFICATION_RATE_LIMITED, '验证码请求过多，请稍后再试');
  }

  const code = generateVerificationCode();
  const codeHash = hashVerificationCode(email, code, env.NEXTAUTH_SECRET);
  const challengeData = {
    codeHash,
    requestIpHash: ipHash,
    attempts: 0,
    sentAt: now,
    expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
    consumedAt: null,
  };
  let challenge: { id: string };
  if (current) {
    const reserved = await prisma.emailVerificationChallenge.updateMany({
      where: {
        id: current.id,
        sentAt: { lte: new Date(now.getTime() - VERIFICATION_RESEND_COOLDOWN_MS) },
      },
      data: challengeData,
    });
    if (reserved.count !== 1) {
      return error(request, ERROR_CODES.AUTH_VERIFICATION_RATE_LIMITED, '验证码发送过于频繁，请稍后再试');
    }
    challenge = { id: current.id };
  } else {
    try {
      challenge = await prisma.emailVerificationChallenge.create({
        data: { email, ...challengeData },
        select: { id: true },
      });
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
        return error(request, ERROR_CODES.AUTH_VERIFICATION_RATE_LIMITED, '验证码发送过于频繁，请稍后再试');
      }
      throw cause;
    }
  }

  try {
    await sendRegistrationVerificationEmail(email, code, env);
  } catch {
    await prisma.emailVerificationChallenge.deleteMany({ where: { id: challenge.id, codeHash } });
    return error(request, ERROR_CODES.AUTH_EMAIL_DELIVERY_FAILED, '验证码暂时无法发送，请稍后重试');
  }

  return NextResponse.json({ ok: true, expiresInSeconds: VERIFICATION_TTL_MS / 1000 });
}

function error(request: Request, code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], message: string) {
  return toApiErrorResponse({ code, message, requestId: withRequestId(request.headers) });
}
