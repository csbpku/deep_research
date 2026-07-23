// 邮箱域 allowlist 与账号启用检查。
//
// 契约源：
//   - docs/contracts/env-and-scripts.md §2（ALLOWED_EMAIL_DOMAINS）
//   - docs/contracts/state-machines.md §10 UserRole（role=admin 时 disabledAt 必须 NULL；
//     这一约束由数据库 CHECK 保障，BFF 不重复校验）

import type { WebEnv } from '../env';

export type UserLike = {
  id: string;
  email: string;
  role: 'member' | 'admin';
  disabledAt: Date | string | null;
};

/** 提取 email 域名（@ 后的小写串）。空 local part / 空 domain / 无 @ 一律返回 ''。 */
export function domainOf(email: string): string {
  if (typeof email !== 'string' || email.length === 0) return '';
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return '';
  return email.slice(at + 1).toLowerCase();
}

/**
 * 是否在 ALLOWED_EMAIL_DOMAINS allowlist 内。空 allowlist 一律拒绝。
 *
 * 注意：精确域名匹配，不做子域递归。例如配置 `example.com` 时，`a.example.com`
 * 也算通过 —— 这是常见的企业邮箱期望行为（`alice@a.example.com` 应允许）。
 * 若需严格匹配，由 allowlist 配置方加完整子域。
 */
export function isEmailAllowed(email: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return false;
  const d = domainOf(email);
  if (!d) return false;
  const lower = allowlist.map((x) => x.toLowerCase());
  return lower.includes(d) || lower.some((allowed) => d.endsWith('.' + allowed));
}

/** 账号是否启用：仅当 disabledAt 为 null 才视为启用。 */
export function isAccountActive(u: Pick<UserLike, 'disabledAt'> | null): boolean {
  if (!u) return false;
  return u.disabledAt === null;
}

/**
 * 解析登录用户信息（来自 NextAuth profile 或 DB upsert）。用于在 signIn callback
 * 中判断该用户当前是否被禁用 —— 已禁用用户拒绝建立新 session。
 *
 * 注释：state-machines.md §10 "admin 不能被静默禁用" 由 SQL CHECK 保障，本函数不参与
 * 角色判断（roles 不能跨过 disabled 标志），仅看 disabledAt 字段。
 */
export function canEstablishSession(u: UserLike | null): boolean {
  if (!u) return true; // 新用户允许建立；signIn 阶段 DB 里查不到时返回 true 让 upsert 接管
  return isAccountActive(u);
}

/** 用 env 一步做域检查（高频路径：signIn callback）。 */
export function isEmailAllowedByEnv(email: string, env: Pick<WebEnv, 'ALLOWED_EMAIL_DOMAINS'>): boolean {
  return isEmailAllowed(email, env.ALLOWED_EMAIL_DOMAINS);
}