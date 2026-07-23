import { EmptyState } from '../../components/EmptyState';
import { signIn } from '../../lib/auth/config';

export default function SignInPage({
  searchParams,
}: {
  searchParams: { error?: string; callbackUrl?: string };
}) {
  const error = searchParams?.error;
  const callbackUrl = searchParams?.callbackUrl ?? '/';

  if (error) {
    return (
      <div style={{ maxWidth: 480, margin: '40px auto' }}>
        <h1 style={{ fontSize: 22 }}>登录失败</h1>
        <EmptyState
          title="登录失败"
          description={
            error === 'AccessDenied'
              ? '你的邮箱域不在允许列表内，或账号已被禁用。请使用公司邮箱重试。'
              : `登录失败（error=${error}）。请重试或联系管理员。`
          }
          action={
            <form action={async () => { 'use server'; await signIn('google', { redirectTo: callbackUrl }); }}>
              <button type="submit" style={{ padding: '10px 20px', border: 'none', borderRadius: 6, background: '#0f172a', color: '#fff', cursor: 'pointer', fontSize: 14 }}>重新登录</button>
            </form>
          }
        />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: '40px auto', textAlign: 'center' }}>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>登录</h1>
      <p style={{ color: '#475569', fontSize: 14, marginBottom: 24 }}>
        使用 Google 账号登录。邮箱必须在允许域名列表内。
      </p>
      <form
        action={async () => {
          'use server';
          await signIn('google', { redirectTo: callbackUrl });
        }}
      >
        <button
          type="submit"
          style={{
            padding: '12px 28px',
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            background: '#fff',
            color: '#0f172a',
            fontSize: 15,
            fontWeight: 500,
            cursor: 'pointer',
            boxShadow: '0 1px 3px rgba(0,0,0,.08)',
          }}
        >
          <span style={{ marginRight: 8 }}>G</span>
          使用 Google 登录
        </button>
      </form>
      <details style={{ marginTop: 24, color: '#475569', fontSize: 13, textAlign: 'left' }}>
        <summary>本地开发提示</summary>
        <ul>
          <li>需在 Google Cloud Console 登记 <code>http://localhost:3000/api/auth/callback/google</code> 为已授权重定向 URI。</li>
          <li>未在 ALLOWED_EMAIL_DOMAINS 的域名会被拒绝（?error=AccessDenied）。</li>
          <li>已禁用账号无法建立新 session。</li>
        </ul>
      </details>
    </div>
  );
}