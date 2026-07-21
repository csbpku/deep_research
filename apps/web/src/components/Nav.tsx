'use client';

import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { useEffect, useState } from 'react';

/**
 * 顶部导航。
 * - P0 入口：每日摘要 / 沉淀 / AI 调研
 * - Admin 入口仅 admin 可见
 * - 未登录显示「登录」按钮
 *
 * 前端显隐仅作体验；直链访问 /admin* 仍会被服务端 requireAdmin() 拒绝（验收 2）。
 *
 * Week 2 改动：用 /api/auth/session 轻量轮询（30s）替换 Week 1 的占位；
 * 不引入 SessionProvider —— 仅登录态显隐这一个用途。
 */
type SessionView = {
  user?: { email?: string; role?: 'admin' | 'member'; name?: string };
} | null;

export function Nav() {
  const [session, setSession] = useState<SessionView>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/auth/session', { cache: 'no-store' });
        if (!r.ok) {
          if (!cancelled) setSession(null);
          return;
        }
        const body = (await r.json()) as SessionView;
        if (!cancelled) setSession(body);
      } catch {
        if (!cancelled) setSession(null);
      }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const isAdmin = session?.user?.role === 'admin';

  return (
    <nav
      style={{
        borderBottom: '1px solid #e2e8f0',
        background: '#fff',
        padding: '12px 16px',
        display: 'flex',
        gap: 16,
        alignItems: 'center',
      }}
    >
      <Link href="/" style={{ fontWeight: 600 }}>
        技术调研
      </Link>
      <Link href="/summaries">每日摘要</Link>
      <Link href="/researches">沉淀</Link>
      <Link href="/ai-research">AI 调研</Link>
      {isAdmin ? <Link href="/admin">Admin</Link> : null}
      <div style={{ marginLeft: 'auto' }}>
        {session?.user ? (
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ color: '#475569', fontSize: 14 }}>
              {session.user.email} {session.user.role === 'admin' ? '(admin)' : ''}
            </span>
            <button
              type="button"
              onClick={() => signOut({ callbackUrl: '/signin' })}
              style={{
                border: '1px solid #cbd5e1',
                background: '#fff',
                padding: '4px 10px',
                borderRadius: 4,
              }}
            >
              登出
            </button>
          </span>
        ) : (
          <Link
            href="/signin"
            style={{
              border: '1px solid #0f172a',
              background: '#0f172a',
              color: '#fff',
              padding: '4px 10px',
              borderRadius: 4,
            }}
          >
            登录
          </Link>
        )}
      </div>
    </nav>
  );
}
