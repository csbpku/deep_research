'use client';

import { Alert, Button, Stack, Typography } from '@mui/material';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Alert severity="error" sx={{ maxWidth: 760, mx: 'auto', p: 2 }}>
      <Stack sx={{ gap: 1 }}>
        <Typography variant="subtitle2">Admin 页面暂时无法打开</Typography>
        <Typography variant="body2">运营数据或治理模块加载时遇到问题。重试不会提交任何治理操作。</Typography>
        <Button variant="contained" size="small" onClick={reset} sx={{ alignSelf: 'flex-start', mt: 1 }}>
          重新加载
        </Button>
      </Stack>
    </Alert>
  );
}
