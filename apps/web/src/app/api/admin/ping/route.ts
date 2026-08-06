import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { apiHandler } from '../../../../lib/api-handler';
import { requireAdmin } from '../../../../lib/auth/session';
import { log } from '../../../../lib/log';

/**
 * GET /api/admin/ping — Admin 健康检查 endpoint。
 *
 * 验收 2 测试样本：
 *   - 未登录 → 401 AUTH_NOT_AUTHENTICATED
 *   - member  → 403 PERMISSION_DENIED
 *   - admin   → 200 { ok: true, role: 'admin' }
 */
export const GET = apiHandler<[NextRequest]>(async (req) => {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;
  log.info('admin.ping', 'ok', { userId: u.id, role: u.role });
  return NextResponse.json({ ok: true, role: u.role, userId: u.id });
});
