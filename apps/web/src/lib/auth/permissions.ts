// BFF 权限 helper —— 角色校验、资源 owner 校验。
//
// 全局 DoD（IMPLEMENTATION_PLAN §一）：
//   - API 输入有服务端校验（zod）
//   - 前端显隐不能替代权限检查
//   - 关键操作写结构化日志
//
// 本文件只导出纯函数 helper（requireRole / requireOwner）。requireAdmin 在
// session.ts 里实现，避免本文件 -> session.ts 的循环/副作用导入路径。

import { NextResponse } from 'next/server';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { toApiErrorResponse } from '../errors';
import type { SessionUser } from './session';

/** 角色校验：非 role 抛 PERMISSION_DENIED（403）。 */
export function requireRole(user: SessionUser, role: 'admin' | 'member'): SessionUser | NextResponse {
  if (user.role !== role) {
    return toApiErrorResponse({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: role === 'admin' ? '需要管理员权限' : '权限不足',
      requestId: user.id, // 用 userId 当 requestId 兜底；上层通常已有更精确的 requestId
    });
  }
  return user;
}

/** 资源 owner 校验：resource.authorId !== user.id → PERMISSION_DENIED。 */
export function requireOwner(
  user: SessionUser,
  resource: { authorId: string } | { ownerId: string } | null | undefined,
): SessionUser | NextResponse {
  if (!resource) {
    return toApiErrorResponse({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: '资源不存在或不属于当前用户',
      requestId: user.id,
    });
  }
  const ownerId = 'authorId' in resource ? resource.authorId : 'ownerId' in resource ? resource.ownerId : null;
  if (!ownerId || ownerId !== user.id) {
    return toApiErrorResponse({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: '只能操作自己的资源',
      requestId: user.id,
    });
  }
  return user;
}