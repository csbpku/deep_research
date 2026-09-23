'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

  return (
    <section className="mt-6 rounded-lg border border-border bg-card p-5 text-left">
      <div className="flex gap-2 border-b border-border pb-3">
        <button
          type="button"
          className={mode === 'signin' ? 'font-medium text-foreground' : 'text-muted-foreground'}
          onClick={() => {
            setMode('signin');
            setError(null);
            setNotice(null);
          }}
        >
          邮箱密码登录
        </button>
        <span className="text-muted-foreground">/</span>
        <button
          type="button"
          className={mode === 'register' ? 'font-medium text-foreground' : 'text-muted-foreground'}
          onClick={() => {
            setMode('register');
            setError(null);
            setNotice(null);
          }}
        >
          注册账号
        </button>
      </div>

      <form onSubmit={submit} className="mt-4 space-y-4">
        {mode === 'register' && betaMode ? (
          <p className="border-l-2 border-primary/60 pl-3 text-xs leading-5 text-muted-foreground">
            当前为 Beta 测试，仅限管理员白名单中的邮箱注册。
          </p>
        ) : null}
        {mode === 'register' ? (
          <div className="space-y-1.5">
            <Label htmlFor="name">名称</Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder="可选"
              disabled={pending}
            />
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="email">邮箱</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            disabled={pending}
          />
        </div>
        {mode === 'register' && emailVerification ? (
          <div className="space-y-1.5">
            <Label htmlFor="verificationCode">邮箱验证码</Label>
            <div className="flex gap-2">
              <Input
                id="verificationCode"
                name="verificationCode"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={verificationCode}
                onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6 位验证码"
                required
                disabled={pending}
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={pending || sendingCode || codeCooldown > 0 || !email.trim()}
                onClick={sendVerificationCode}
              >
                {sendingCode ? '发送中…' : codeCooldown > 0 ? `${codeCooldown}s` : '发送验证码'}
              </Button>
            </div>
            {codeNotice ? <p className="text-xs text-muted-foreground" role="status">{codeNotice}</p> : null}
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="password">密码</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            required
            disabled={pending}
          />
          {mode === 'register' ? (
            <p className="text-xs text-muted-foreground">
              至少 {PASSWORD_MIN_LENGTH} 个字符。
            </p>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? '处理中…' : mode === 'register' ? '注册并登录' : '登录'}
        </Button>
      </form>
    </section>
  );
}
