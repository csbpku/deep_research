// Idempotent bootstrap for the initial Admin.
//
// Triggered by:
//   - `scripts/setup.sh` (local dev / VPS pack)
//   - `scripts/docker-entrypoint-web.sh` (Docker compose)
//
// Contract (P1-A1):
//   - Reads BOOTSTRAP_ADMIN_EMAIL + ALLOWED_EMAIL_DOMAINS from env.
//   - If unset, exits 0 with [skip] log (first deploy / SSO admin already exists).
//   - Validates the email belongs to an allowed domain (allowlist reuse).
//   - Upserts the user; promotes to admin **only if there is no admin yet** or the
//     user is already admin. Never demotes an existing admin.
//   - Prints an audit-friendly summary, but never the password or full token.
//
// Usage:
//   BOOTSTRAP_ADMIN_EMAIL=alice@example.com \
//   ALLOWED_EMAIL_DOMAINS=example.com \
//   DATABASE_URL=... tsx scripts/bootstrap-admin.ts

import { PrismaClient, type UserRole } from '@prisma/client';

const prisma = new PrismaClient();

function csvDomains(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '';
  return email.slice(at + 1).toLowerCase();
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '<invalid>';
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

type Outcome =
  | { kind: 'skipped_no_bootstrap_email'; reason: string }
  | { kind: 'skipped_disabled_bootstrap_email'; reason: string }
  | { kind: 'created'; userId: string; role: UserRole }
  | { kind: 'promoted'; userId: string; from: UserRole; to: UserRole }
  | { kind: 'unchanged_admin'; userId: string }
  | { kind: 'unchanged_existing_non_admin_with_other_admin'; userId: string }
  | { kind: 'would_demote_blocked'; userId: string; reason: string };

async function main(): Promise<Outcome> {
  const emailRaw = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() ?? '';
  const allow = csvDomains(process.env.ALLOWED_EMAIL_DOMAINS);

  if (!emailRaw) {
    return { kind: 'skipped_no_bootstrap_email', reason: 'BOOTSTRAP_ADMIN_EMAIL 未设置' };
  }
  if (emailRaw.toLowerCase() === 'disabled' || emailRaw.toLowerCase() === 'off') {
    return { kind: 'skipped_disabled_bootstrap_email', reason: 'BOOTSTRAP_ADMIN_EMAIL 被显式关闭' };
  }
  const email = emailRaw.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error(`BOOTSTRAP_ADMIN_EMAIL 非法: ${emailRaw}`);
  }
  const domain = domainOf(email);
  if (allow.length > 0 && !allow.includes(domain)) {
    throw new Error(
      `BOOTSTRAP_ADMIN_EMAIL 的域名 ${domain} 不在 ALLOWED_EMAIL_DOMAINS(${allow.join(',')}) 内`,
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  const adminCount = await prisma.user.count({ where: { role: 'admin', disabledAt: null } });

  if (!existing) {
    const created = await prisma.user.create({
      data: {
        email,
        name: email.split('@')[0] ?? 'Bootstrap Admin',
        role: 'admin',
      },
      select: { id: true, role: true },
    });
    return { kind: 'created', userId: created.id, role: created.role };
  }

  if (existing.role === 'admin') {
    if (existing.disabledAt) {
      // 已禁用 admin 不复活；这是产品决策而非 bootstrap 行为。
      throw new Error(
        `BOOTSTRAP_ADMIN_EMAIL ${maskEmail(email)} 对应账号已禁用，请在 Admin 控制台手动恢复`,
      );
    }
    return { kind: 'unchanged_admin', userId: existing.id };
  }

  if (existing.disabledAt) {
    throw new Error(
      `BOOTSTRAP_ADMIN_EMAIL ${maskEmail(email)} 对应账号已禁用，禁止作为 bootstrap admin 复活`,
    );
  }

  if (adminCount > 0) {
    // 已存在非 admin 用户 + 已有其它 admin：避免擅自提升；要求人工在控制台操作。
    return {
      kind: 'unchanged_existing_non_admin_with_other_admin',
      userId: existing.id,
    };
  }

  // 没有任何 active admin —— 安全地把该用户提升为 admin。
  const updated = await prisma.user.update({
    where: { id: existing.id },
    data: { role: 'admin' },
    select: { id: true, role: true },
  });
  return { kind: 'promoted', userId: updated.id, from: existing.role, to: updated.role };
}

function describe(outcome: Outcome, email?: string): string {
  switch (outcome.kind) {
    case 'skipped_no_bootstrap_email':
      return `[bootstrap:admin] skip: ${outcome.reason}`;
    case 'skipped_disabled_bootstrap_email':
      return `[bootstrap:admin] skip: ${outcome.reason}`;
    case 'created':
      return `[bootstrap:admin] created admin user (id=${outcome.userId.slice(0, 8)}…)`;
    case 'promoted':
      return `[bootstrap:admin] promoted user ${outcome.userId.slice(0, 8)}…: ${outcome.from} → ${outcome.to}`;
    case 'unchanged_admin':
      return `[bootstrap:admin] user ${outcome.userId.slice(0, 8)}… 已是 admin，跳过`;
    case 'unchanged_existing_non_admin_with_other_admin':
      return `[bootstrap:admin] user ${outcome.userId.slice(0, 8)}… 存在但非 admin；当前已有 ${'(至少 1)'} active admin，未自动提升 — 请在控制台手动升级`;
    case 'would_demote_blocked':
      return `[bootstrap:admin] 拒绝: ${outcome.reason}`;
  }
  return `[bootstrap:admin] ${email ?? ''}`;
}

async function logAudit(outcome: Outcome): Promise<void> {
  // Bootstrap 是启动期系统动作：actor/target 可能尚未存在；admin_actions 是
  // 人工操作审计，不适合写系统启动事件。Console 日志保留"创建/提升/跳过"
  // 三类可审计线索即可；真正的 Admin 操作（升级/降级/禁用）由 P1-A3 端点
  // 落 admin_actions 表。
  void outcome;
}

main()
  .then(async (outcome) => {
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
    console.log(describe(outcome, email));
    await logAudit(outcome);
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[bootstrap:admin] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
