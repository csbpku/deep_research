import Link from 'next/link';
import { EmptyState } from '../../components/EmptyState.js';

export default function SignInPage({
  searchParams,
}: {
  searchParams: { error?: string; callbackUrl?: string };
}) {
  const error = searchParams?.error;
  const callbackUrl = searchParams?.callbackUrl;
  return (
    <div style={{ maxWidth: 480, margin: '40px auto' }}>
      <h1 style={{ fontSize: 22 }}>登录</h1>
      <p style={{ color: '#475569' }}>
        点击下方按钮使用 Google 账号登录。邮箱必须在 ALLOWED_EMAIL_DOMAINS allowlist 内；
        域外的用户会被 NextAuth 拒绝。
      </p>

      <EmptyState
        title="Week 1 占位登录页"
        description={
          error
            ? `登录失败（error=${error}）。请确认邮箱域在 allowlist 内，且账号未被禁用。`
            : 'Google OAuth 按钮将在 Week 2 接入 next-auth/react 的 signIn()；当前仅占位。'
        }
        action={
          <Link
            href={callbackUrl ?? '/'}
            style={{ color: '#0f172a', textDecoration: 'underline' }}
          >
            返回首页
          </Link>
        }
      />

      <details style={{ marginTop: 24, color: '#475569', fontSize: 13 }}>
        <summary>本地开发提示</summary>
        <ul>
          <li>Google OAuth callback 固定 <code>http://localhost:3000/api/auth/callback/google</code>，需在 Google Cloud Console OAuth client 登记完全相同的 URI。</li>
          <li>未在 allowlist 的域名登录会被 NextAuth 拒绝（?error=AccessDenied）。</li>
          <li>已禁用账号（<code>users.disabledAt</code> 非空）无法建立新 session。</li>
        </ul>
      </details>
    </div>
  );
}