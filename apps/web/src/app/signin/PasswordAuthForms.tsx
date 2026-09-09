'use client';

import { useState, type FormEvent } from 'react';
import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@/lib/auth/password-policy';

type Mode = 'signin' | 'activate';

export function PasswordAuthForms({ callbackUrl }: { callbackUrl: string }) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    try {
      if (mode === 'activate') {
        const response = await fetch('/api/auth/activate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, name, password, inviteCode }),
        });
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        if (!response.ok) {
          throw new Error(body?.message ?? '激活失败，请检查邮箱和邀请码');
        }
        setNotice('激活成功，正在登录…');
      }

      const result = await signIn('password', {
        email,
        password,
        redirect: false,
        redirectTo: callbackUrl,
      });
      if (!result || result.error) {
        throw new Error('邮箱或密码不正确，或账号尚未启用密码登录');
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
          className={mode === 'activate' ? 'font-medium text-foreground' : 'text-muted-foreground'}
          onClick={() => {
            setMode('activate');
            setError(null);
            setNotice(null);
          }}
        >
          邀请码激活
        </button>
      </div>

      <form onSubmit={submit} className="mt-4 space-y-4">
        {mode === 'activate' ? (
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
        {mode === 'activate' ? (
          <div className="space-y-1.5">
            <Label htmlFor="inviteCode">邀请码</Label>
            <Input
              id="inviteCode"
              name="inviteCode"
              type="password"
              autoComplete="one-time-code"
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              required
              disabled={pending}
              placeholder="请输入管理员提供的邀请码"
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
        <div className="space-y-1.5">
          <Label htmlFor="password">密码</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === 'activate' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            required
            disabled={pending}
          />
          {mode === 'activate' ? (
            <p className="text-xs text-muted-foreground">
              至少 {PASSWORD_MIN_LENGTH} 个字符；邮箱必须在允许名单内。
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
          {pending ? '处理中…' : mode === 'activate' ? '激活并登录' : '登录'}
        </Button>
      </form>
    </section>
  );
}
