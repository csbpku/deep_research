// /admin/radar server-side 守卫（Week 9 修复）。
//
// 之前：page.tsx 是 client component，user 状态通过 useQuery 异步获取，
// 未登录用户会先看到 403 EmptyState，URL 仍停在 /admin/radar，体验割裂。
//
// 修法：page.tsx 改为 server component，直接在 server 端 redirect。

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { Alert, Box, Typography } from '@mui/material';
import { adminRootSx, Button } from '../AdminMaterial';
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
      <Box sx={[adminRootSx, { mx: 'auto', width: '100%', maxWidth: 760 }]}>
        <Typography variant="h1" component="h1">Admin</Typography>
        <Alert severity="error" sx={{ mt: 2 }}>
          <Typography variant="subtitle2" component="div">403 — 需要管理员权限</Typography>
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            当前账号 {maskEmail(u.email)} 角色为普通成员；Admin 入口仅管理员可见。
          </Typography>
          <Button asChild variant="outline" size="sm" sx={{ mt: 2 }}>
            <Link href="/">返回首页</Link>
          </Button>
        </Alert>
      </Box>
    );
  }
  return <AdminRadarClient />;
}
