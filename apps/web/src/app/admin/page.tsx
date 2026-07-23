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
        Week 5：技术雷达候选队列入口。
      </p>
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
        <li>
          <a
            href="/admin/radar"
            style={{
              display: 'block',
              padding: 16,
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              background: '#fff',
              textDecoration: 'none',
              color: '#0f172a',
            }}
          >
            <strong>雷达队列</strong>
            <p style={{ margin: '4px 0 0', color: '#475569', fontSize: 13 }}>
              选入每日摘要 / 创建 AI 调研 / 忽略 / 重试解读
            </p>
          </a>
        </li>
      </ul>
    </div>
  );
}