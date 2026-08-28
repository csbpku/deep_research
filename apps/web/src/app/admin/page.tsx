import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/domain/PageHeader';
import AdminConsole from './AdminConsole';

/**
 * Admin 控制台入口（Server Component）：
 *   - 服务端鉴权拦截；未登录跳 /signin，非 admin 渲染 403
 *   - 真正的 UI 放在 client 子组件，便于复用 useQuery / useMutation
 */

/** 把 email 局部 mask:u***@example.com,避免拒绝页变成 phishing pivot */
function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return email;
  const head = user.slice(0, 1);
  return `${head}***@${domain}`;
}

export default async function AdminPage() {
  const u = await getCurrentUser();
  if (!u) redirect('/signin?callbackUrl=/admin');
  if (u.role !== 'admin') {
    return (
      <div className="mx-auto max-w-measure">
        <PageHeader title="Admin" description="Admin 控制台 · 仅管理员可见" />
        <EmptyState
          title="403 — 需要管理员权限"
          description={`当前账号 ${maskEmail(u.email)} 角色为普通成员；Admin 入口仅管理员可见。`}
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/">返回首页</Link>
              </Button>
            </div>
          }
        />
      </div>
    );
  }
  return <AdminConsole />;
}
