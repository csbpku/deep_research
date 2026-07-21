import Link from 'next/link';
import { getCurrentUser } from '../lib/auth/session.js';
import { SignOutButton } from './SignOutButton.js';

/**
 * 顶部导航 — RSC。
 * - P0 入口：每日摘要 / 沉淀 / AI 调研
 * - Admin 入口仅 admin 可见（服务端读 session）
 * - 未登录显示「登录」按钮
 *
 * 前端显隐仅作体验；直链访问 /admin* 仍会被服务端 requireAdmin() 拒绝（验收 2）。
 *
 * Week 1 review 修正：原版 useSessionPlaceholder() 永远返回 null，admin 自己
 * 也看不见入口。本版用 RSC 直接调 getCurrentUser()，signOut 抽到独立 client component。
 */
export async function Nav() {
  const user = await getCurrentUser();
  const isAdmin = user?.role === 'admin';

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
        {user ? (
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ color: '#475569', fontSize: 14 }}>
              {user.email} {user.role === 'admin' ? '(admin)' : ''}
            </span>
            <SignOutButton />
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