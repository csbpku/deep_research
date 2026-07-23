import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../lib/auth/session';
import { EmptyState } from '../../components/EmptyState';

/**
 * Admin 入口页。
 *
 * 服务端拦截：未登录跳 /signin；非 admin 仍渲染 403 提示（不抛错，与前端用户体验一致）。
 * 直链 /admin 安全性由本文件 + /api/admin/* 服务端校验双重保障（验收 2）。
 */
export default async function AdminPage() {
  const u = await getCurrentUser();
  if (!u) redirect('/signin?callbackUrl=/admin');
  if (u.role !== 'admin') {
    return (
      <div>
        <h1 style={{ fontSize: 22 }}>Admin</h1>
        <EmptyState
          title="403 — 需要管理员权限"
          description={`当前账号 ${u.email} 角色为 ${u.role}；Admin 入口仅 admin 可见。`}
        />
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ fontSize: 22 }}>Admin 控制台</h1>
      <p style={{ color: '#475569' }}>
        Week 1 占位。Week 8 落地：分享审核、提名审核、成员管理（设 admin / 禁用 / 恢复）。
      </p>
      <EmptyState
        title="占位"
        description="Admin 首页 P0 只显示待审核数和失败 job 数，不实现 P1 统计图表（IMP §十四）。"
      />
    </div>
  );
}