'use client';

import { ArrowLeft, Home, RotateCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import { space, tokens } from '@deep-research/design-system';

export function RouteErrorState({
  title = '页面暂时无法打开',
  description = '页面加载时遇到了一点问题。可以重试当前页面，或回到工作台继续。',
  reset,
}: {
  title?: string;
  description?: string;
  reset: () => void;
}) {
  const router = useRouter();

  return (
    <Box
      component="div"
      sx={{
        display: 'flex',
        minHeight: '60vh',
        width: '100%',
        maxWidth: tokens['width-reading'],
        alignItems: 'center',
        justifyContent: 'center',
        marginInline: 'auto',
        paddingInline: { xs: space.md, sm: space.lg },
        paddingBlock: { xs: space.section, sm: space.wide },
      }}
    >
      <Alert
        component="section"
        severity="error"
        icon={false}
        role="alert"
        aria-live="assertive"
        sx={{
          width: '100%',
          borderRadius: tokens['radius-small'],
          padding: { xs: space.lg, sm: space.xl },
          '& .MuiAlert-message': { width: '100%', minWidth: 0, padding: 0 },
        }}
      >
        <Typography component="p" variant="subtitle2" color="error.main" sx={{ margin: 0 }}>
          {title}
        </Typography>
        <Typography component="p" variant="body2" color="text.secondary" sx={{ margin: 0, marginTop: space.sm }}>
          {description}
        </Typography>
        <Stack direction="row" useFlexGap sx={{ marginTop: space.lg, flexWrap: 'wrap', gap: space.sm }}>
          <Button type="button" variant="contained" startIcon={<RotateCw />} onClick={reset}>
            重试
          </Button>
          <Button type="button" variant="outlined" startIcon={<ArrowLeft />} onClick={() => router.back()}>
            返回上一页
          </Button>
          <Button type="button" variant="text" startIcon={<Home />} onClick={() => router.push('/')}>
            回到工作台
          </Button>
        </Stack>
      </Alert>
    </Box>
  );
}
