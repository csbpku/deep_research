'use client';

import React, { useEffect, useState, type FormEvent } from 'react';
import { signIn } from 'next-auth/react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { space } from '@deep-research/design-system';
import { AppButton } from '@/components/material/AppButton';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@/lib/auth/password-policy';

type Mode = 'signin' | 'register';

export function PasswordAuthForms({
  callbackUrl,
  betaMode,
  emailVerification,
}: {
  callbackUrl: string;
  betaMode: boolean;
  emailVerification: boolean;
}) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [codeNotice, setCodeNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (codeCooldown <= 0) return;
    const timer = window.setInterval(() => setCodeCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [codeCooldown]);

  async function sendVerificationCode() {
    setError(null);
    setCodeNotice(null);
    setSendingCode(true);
    try {
      const response = await fetch('/api/auth/verification/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? '验证码发送失败');
      setCodeCooldown(60);
      setCodeNotice('验证码已发送，10 分钟内有效。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '验证码发送失败，请稍后重试');
    } finally {
      setSendingCode(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    try {
      if (mode === 'register') {
        const response = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, name, password, verificationCode }),
        });
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        if (!response.ok) {
          throw new Error(body?.message ?? '注册失败，请检查账号信息');
        }
        setNotice('注册成功，正在登录…');
      }

      const result = await signIn('password', {
        email,
        password,
        redirect: false,
        redirectTo: callbackUrl,
      });
      if (!result || result.error) {
        throw new Error('邮箱或密码不正确，或账号暂未启用密码登录');
      }
      window.location.assign(result.url ?? callbackUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后重试');
      setNotice(null);
    } finally {
      setPending(false);
    }
  }

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
    setError(null);
    setNotice(null);
  }

  return (
      <Paper component="section" variant="outlined" sx={{ padding: { xs: space.md, sm: space.lg }, textAlign: 'left' }}>
        <Tabs
          value={mode}
          onChange={(_event, value: Mode) => changeMode(value)}
          variant="fullWidth"
          aria-label="邮箱登录或注册"
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab id="auth-signin-tab" aria-controls="auth-form-panel" value="signin" label="邮箱密码登录" />
          <Tab id="auth-register-tab" aria-controls="auth-form-panel" value="register" label="注册账号" />
        </Tabs>

        <Box role="tabpanel" id="auth-form-panel" aria-labelledby={`auth-${mode}-tab`} sx={{ paddingTop: space.lg }}>
          <Stack component="form" onSubmit={submit} sx={{ gap: space.md }}>
            {mode === 'register' && betaMode ? (
              <Typography component="p" variant="metadata" color="text.secondary" sx={{ borderLeft: 2, borderColor: 'primary.main', paddingLeft: space.sm }}>
                当前为 Beta 测试，仅限管理员白名单中的邮箱注册。
              </Typography>
            ) : null}
            {mode === 'register' ? (
              <TextField
                fullWidth
                id="name"
                name="name"
                label="名称"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                slotProps={{ htmlInput: { maxLength: 80 } }}
                placeholder="可选"
                disabled={pending}
              />
            ) : null}
            <TextField
              fullWidth
              id="email"
              name="email"
              type="email"
              label="邮箱"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              disabled={pending}
            />
            {mode === 'register' && emailVerification ? (
              <Stack
                sx={{
                  flexDirection: { xs: 'column', sm: 'row' },
                  alignItems: { xs: 'stretch', sm: 'flex-start' },
                  gap: space.sm,
                }}
              >
                <TextField
                  fullWidth
                  id="verificationCode"
                  name="verificationCode"
                  label="邮箱验证码"
                  autoComplete="one-time-code"
                  slotProps={{ htmlInput: { inputMode: 'numeric', pattern: '[0-9]{6}', maxLength: 6 } }}
                  value={verificationCode}
                  onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="6 位验证码"
                  required
                  disabled={pending}
                  sx={{ flex: 1, minWidth: 0 }}
                />
                <AppButton
                  type="button"
                  variant="outlined"
                  disabled={pending || sendingCode || codeCooldown > 0 || !email.trim()}
                  onClick={sendVerificationCode}
                  sx={{ flexShrink: 0, width: { xs: '100%', sm: 'auto' } }}
                >
                  {sendingCode ? '发送中…' : codeCooldown > 0 ? `${codeCooldown}s` : '发送验证码'}
                </AppButton>
              </Stack>
            ) : null}
            <TextField
              fullWidth
              id="password"
              name="password"
              type="password"
              label="密码"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              slotProps={{ htmlInput: { minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH } }}
              required
              disabled={pending}
            />
            {codeNotice ? <Typography component="p" variant="metadata" color="text.secondary" role="status">{codeNotice}</Typography> : null}
            {mode === 'register' ? (
              <Typography component="p" variant="metadata" color="text.secondary">
                至少 {PASSWORD_MIN_LENGTH} 个字符。
              </Typography>
            ) : null}
            {error ? (
              <Alert severity="error" variant="outlined">
                {error}
              </Alert>
            ) : null}
            {notice ? (
              <Alert severity="info" variant="outlined" role="status">
                {notice}
              </Alert>
            ) : null}
            <AppButton type="submit" variant="contained" fullWidth disabled={pending}>
              {pending ? '处理中…' : mode === 'register' ? '注册并登录' : '登录'}
            </AppButton>
          </Stack>
        </Box>
    </Paper>
  );
}
