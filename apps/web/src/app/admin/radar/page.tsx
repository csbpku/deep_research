// /admin/radar server-side 守卫（Week 9 修复）。
//
// 之前：page.tsx 是 client component，user 状态通过 useQuery 异步获取，
// 未登录用户会先看到 403 EmptyState，URL 仍停在 /admin/radar，体验割裂。
//
// 修法：page.tsx 改为 server component，直接在 server 端 redirect。

import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../lib/auth/session';
import { EmptyState } from '../../../components/EmptyState';
import AdminRadarClient from './AdminRadarClient';

export default async function AdminRadarPage() {
  const u = await getCurrentUser();
  if (!u) {
    redirect('/signin?callbackUrl=/admin/radar');
  }
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
  return <AdminRadarClient />;
}