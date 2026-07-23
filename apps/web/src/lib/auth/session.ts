// BFF 登录校验 helper。
//
// 用法：
//   - Server Component / Route Handler 中：`const user = await requireUser(req)`。
//   - 未登录 / 已禁用 → 返回 NextResponse(ApiError, 401/403)。
//   - 已登录 → 返回 SessionUser，业务 handler 继续执行。

import { NextResponse } from 'next/server';
import { auth } from './config';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { toApiErrorResponse } from '../errors';
import { withRequestId } from '../log';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  role: 'member' | 'admin';
  disabledAt: string | null;
};

export type SessionUserOrNull = SessionUser | null;

/**
 * 取当前 session 里的 user。NextAuth JWT 策略下，session 已被 callbacks.session 注入 id/role/disabledAt。
 *
 * disabledAt 非空视为已禁用，强制返回 null（即便 token 还在）。这是兜底校验，防止 jwt 阶段漏判。
 */
export async function getCurrentUser(): Promise<SessionUserOrNull> {
  const session = await auth();
  if (!session?.user?.id) return null;
  if (session.user.disabledAt) return null;
  return {
    id: session.user.id,
    email: session.user.email ?? '',
    name: session.user.name ?? '',
    image: session.user.image ?? null,
    role: session.user.role,
    disabledAt: session.user.disabledAt ?? null,
  };
}

/**
 * 取当前 user 的 id（快捷）。未登录返回 null。
 */
export async function getCurrentUserId(): Promise<string | null> {
  const u = await getCurrentUser();
  return u?.id ?? null;
}

/** 拿 request_id；优先 incoming header，缺失则生成新 UUID。 */
export function requestIdOf(req: Request): string {
  return withRequestId(req.headers);
}

/**
 * 强校验登录：未登录 → 401 AUTH_NOT_AUTHENTICATED。
 * 返回 SessionUser（永远非 null）。
 */
export async function requireUser(req: Request): Promise<SessionUser | NextResponse> {
  const requestId = requestIdOf(req);
  const u = await getCurrentUser();
  if (!u) {
    return toApiErrorResponse({
      code: ERROR_CODES.AUTH_NOT_AUTHENTICATED,
      message: '需要登录',
      requestId,
    });
  }
  return u;
}

/**
 * requireUser + requireAdmin 一步搞定。返回 SessionUser（非 admin 时返回 NextResponse 错误）。
 *
 * 用法：
 *   const u = await requireAdmin(req);
 *   if (u instanceof NextResponse) return u;
 *   // u 现在是 admin SessionUser
 */
export async function requireAdmin(req: Request): Promise<SessionUser | NextResponse> {
  const requestId = requestIdOf(req);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;
  if (u.role !== 'admin') {
    return toApiErrorResponse({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: '需要管理员权限',
      requestId,
    });
  }
  return u;
}

/** 类型守卫：helper 返回值是否是 NextResponse（错误）。 */
export function isErrorResponse<T>(value: T | NextResponse): value is NextResponse {
  return value instanceof NextResponse;
}