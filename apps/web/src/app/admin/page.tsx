import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { EmptyState } from '@/components/EmptyState';
import AdminConsole from './AdminConsole';

/**
 * Admin 控制台入口（Server Component）：
 *   - 服务端鉴权拦截；未登录跳 /signin，非 admin 渲染 403
 *   - 真正的 UI 放在 client 子组件，便于复用 useQuery / useMutation
 */
export default async function AdminPage() {
  const u = await getCurrentUser();
  if (!u) redirect('/signin?callbackUrl=/admin');
  if (u.role !== 'admin') {
    return (
      <div className="mx-auto max-w-measure">
        <h1 className="mb-4 text-xl font-semibold tracking-normal">Admin</h1>
        <EmptyState
          title="403 — 需要管理员权限"
          description={`当前账号 ${u.email} 角色为普通成员；Admin 入口仅管理员可见。`}
        />
      </div>
    );
  }
  return <AdminConsole />;
}
