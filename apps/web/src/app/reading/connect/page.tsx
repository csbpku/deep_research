'use client';

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { space } from '@deep-research/design-system';
import { AppButton } from '@/components/material/AppButton';

export default function ReadingConnectPage() {
  const [message, setMessage] = useState('正在连接 Deep Research…');
  const [signInHref, setSignInHref] = useState('/signin');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect');
    const challenge = params.get('code_challenge');
    const method = params.get('code_challenge_method');
    const state = params.get('state');
    if (!redirect || !/^chrome-extension:\/\//u.test(redirect) || !challenge || method !== 'S256' || !state) {
      setMessage('授权参数无效，请从插件侧栏重新发起连接。');
      return;
    }
    setSignInHref(`/signin?callbackUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    const tokenUrl = new URL('/api/reading/token', window.location.origin);
    tokenUrl.searchParams.set('redirect', redirect);
    tokenUrl.searchParams.set('code_challenge', challenge);
    tokenUrl.searchParams.set('code_challenge_method', method);
    fetch(tokenUrl.toString(), { credentials: 'include' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.code) throw new Error(body.message || '请先登录');
        const callback = new URL(redirect);
        callback.searchParams.set('code', body.code);
        callback.searchParams.set('state', state);
        window.location.replace(callback.toString());
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : '连接失败，请先登录 Deep Research。'));
  }, []);
  return (
    <Box component="div" sx={{ width: '100%', maxWidth: '480px', marginInline: 'auto', paddingInline: { xs: space.md, sm: space.lg }, paddingBlock: { xs: space.lg, sm: space.wide } }}>
      <Paper variant="outlined" sx={{ padding: { xs: space.lg, sm: space.section }, borderRadius: 'var(--dr-radius-large)', boxShadow: 'var(--dr-elevation-1)' }}>
        <Stack sx={{ alignItems: 'center', gap: space.md, textAlign: 'center' }}>
          <Typography component="p" variant="metadata" color="primary.main" sx={{ fontWeight: 600, letterSpacing: '0.04em' }}>Deep Research Reader</Typography>
          <Typography component="h1" variant="panelTitle">连接平台账号</Typography>
          <Box role="status" aria-live="polite" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: space.sm, width: '100%', minHeight: 'var(--dr-control-height)', padding: space.md, border: 1, borderColor: 'divider', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'background.default', color: 'text.secondary' }}>
            {message === '正在连接 Deep Research…' ? <CircularProgress size={16} aria-label="正在连接" /> : null}
            <Typography component="p" variant="body1" color="text.secondary" sx={{ overflowWrap: 'anywhere', textAlign: 'left' }}>{message}</Typography>
          </Box>
          <AppButton component="a" href={signInHref} variant="contained" fullWidth sx={{ borderRadius: 'var(--dr-radius-small)' }}>登录后重试</AppButton>
        </Stack>
      </Paper>
    </Box>
  );
}
