// /admin/radar server-side 守卫（Week 9 修复）。
//
// 之前：page.tsx 是 client component，user 状态通过 useQuery 异步获取，
// 未登录用户会先看到 403 EmptyState，URL 仍停在 /admin/radar，体验割裂。
//
// 修法：page.tsx 改为 server component，直接在 server 端 redirect。

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/domain/PageHeader';
import AdminRadarClient from './AdminRadarClient';

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return email;
  return `${user.slice(0, 1)}***@${domain}`;
}

export default async function AdminRadarPage() {
  const u = await getCurrentUser();
  if (!u) {
    redirect('/signin?callbackUrl=/admin/radar');
  }
  if (u.role !== 'admin') {
    return (
      <div className="mx-auto max-w-measure">
        <PageHeader title="Admin" description="Admin 控制台 · 仅管理员可见" />
        <EmptyState
          title="403 — 需要管理员权限"
          description={`当前账号 ${maskEmail(u.email)} 角色为普通成员；Admin 入口仅管理员可见。`}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/">返回首页</Link>
            </Button>
          }
        />
      </div>
    );
  }
  return <AdminRadarClient />;
}
