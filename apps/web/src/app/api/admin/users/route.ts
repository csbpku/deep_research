// BFF handler: GET /api/admin/users —— 管理员可见的成员列表。
//
// 设计：仅返回 id / email / name / role / createdAt / disabledAt。
// 给 Admin 控制台的「成员」tab 用来核对角色与禁用状态，Phase 1 不支持编辑。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../lib/db';
import { apiHandler } from '../../../../lib/api-handler';
import { requireAdmin } from '../../../../lib/auth/session';

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
