'use client';

import Link from 'next/link';
import { useSession, signOut } from 'next-auth/react';

/**
 * 顶部导航。
 * - P0 入口：每日摘要 / 沉淀 / AI 调研
 * - Admin 入口仅 admin 可见
 * - 未登录显示「登录」按钮
 *
 * 前端显隐仅作体验；直链访问 /admin* 仍会被服务端 requireAdmin() 拒绝（验收 2）。
 */
export function Nav() {
  // useSession 仅作为前端显隐依据；服务端以 getCurrentUser() / requireAdmin() 为准。
  // 这里用 next-auth/react 的 SessionProvider 必须在 root 包装，Week 1 先用
  // 一个本地轻量轮询避免引入额外 Context provider —— Week 8 接入 Admin UI 时统一改。
  // 简化：直接读 cookie 触发显示态；通过 /api/auth/session 拉一次。
  const session = useSessionPlaceholder();
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
              style={{ border: '1px solid #cbd5e1', background: '#fff', padding: '4px 10px', borderRadius: 4 }}
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

/**
 * 占位：Week 1 不接 SessionProvider（避免在 RootLayout 引入 client provider 后
 * 把整个 layout 变 client component）。这里直接 fetch /api/auth/session 拿一次。
 *
 * Week 2 接入 next-auth/react 的 SessionProvider 后改回 useSession() 即可；
 * 渲染逻辑保持不变。
 */
function useSessionPlaceholder(): { user?: { email?: string; role?: 'admin' | 'member' } } | null {
  // 用 React.useSyncExternalStore 拉一次，避免引入额外依赖
  // 这里用最朴素的版本 —— 静态 null（未登录）；admin 显隐只作前端体验；
  // 服务端 requireAdmin 是真实拦截，前端显隐与服务端解耦。
  // 真正实现见 Week 2。
  if (typeof window === 'undefined') return null;
  return null;
}