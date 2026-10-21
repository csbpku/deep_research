import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { Alert, Box, Typography } from '@mui/material';
import { Button } from './AdminMaterial';
import AdminConsole from './AdminConsole';
import styles from './admin.module.css';

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
      <Box className={styles.adminRoot} sx={{ mx: 'auto', width: '100%', maxWidth: 760 }}>
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
  return <AdminConsole />;
}
