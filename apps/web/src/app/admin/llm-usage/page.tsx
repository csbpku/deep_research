import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import { getCurrentUser } from '@/lib/auth/session';
import LlmUsageConsole from './LlmUsageConsole';
import { adminRootSx } from '../AdminMaterial';

export default async function AdminLlmUsagePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/signin?callbackUrl=/admin/llm-usage');
  if (user.role !== 'admin') {
    return (
      <Box sx={[adminRootSx, { mx: 'auto', width: '100%', maxWidth: 760 }]}>
        <Typography variant="h1" component="h1">Admin</Typography>
        <Alert severity="error" sx={{ mt: 2 }}>
          <Typography variant="subtitle2" component="div">403 — 需要管理员权限</Typography>
          <Typography variant="body2" sx={{ mt: 0.5 }}>仅管理员可以查看模型调用与成本审计。</Typography>
        </Alert>
      </Box>
    );
  }
  return (
    <Box component="div" sx={[adminRootSx, { mx: 'auto', width: '100%', maxWidth: 1280, px: { xs: 2, sm: 3 }, py: 4 }]}>
      <Stack sx={{ mb: 3, flexDirection: { xs: 'column', sm: 'row' }, gap: 2, alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="h1" component="h1">LLM 用量审计</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            模型调用、限额降级、token 与已知成本。
          </Typography>
        </Box>
        <Button component={Link} href="/admin" variant="outlined">返回 Admin</Button>
      </Stack>
      <LlmUsageConsole />
    </Box>
  );
}
