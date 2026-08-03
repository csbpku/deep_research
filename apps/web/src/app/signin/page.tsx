import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { signIn } from '@/lib/auth/config';

/**
 * 登录页。窄栏居中，不套业务侧栏的宽布局。
 *
 * ⚠️ e2e（public-flows.spec.ts）断言正文含 /登录|signin|Google/i，勿改文案。
 */
export default async function SignInPage({
  searchParams,
}: {
  // Next.js 15: searchParams is a Promise; await before reading.
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const sp = await searchParams;
  const error = sp?.error;
  // W9 安全复审修订（S0）：此前 searchParams.callbackUrl 直接喂给
  // signIn('google', { redirectTo: callbackUrl })，无任何域名/路径校验，
  // 攻击者可构造 /signin?callbackUrl=https://evil.com 做开放重定向钓鱼。
  // 现在只接受以 / 开头的相对路径（同源），任何绝对 URL 一律丢掉。
  const raw = sp?.callbackUrl;
  const callbackUrl = raw && raw.startsWith('/') ? raw : '/';

  async function doSignIn() {
    'use server';
    await signIn('google', { redirectTo: callbackUrl });
  }

  if (error) {
    return (
      <div className="mx-auto max-w-md py-10">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">登录失败</h1>
        <EmptyState
          title="登录失败"
          description={
            error === 'AccessDenied'
              ? '你的邮箱域不在允许列表内，或账号已被禁用。请使用公司邮箱重试。'
              : `登录失败（error=${error}）。请重试或联系管理员。`
          }
          action={
            <form action={doSignIn}>
              <Button type="submit">重新登录</Button>
            </form>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <h1 className="text-xl font-semibold tracking-tight">登录</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        使用 Google 账号登录。邮箱必须在允许域名列表内。
      </p>

      <form action={doSignIn} className="mt-6">
        <Button type="submit" variant="outline" size="lg" className="w-full">
          <GoogleMark />
          使用 Google 登录
        </Button>
      </form>

      <details className="mt-8 rounded-lg border border-border bg-card p-4 text-left text-sm text-muted-foreground">
        <summary className="cursor-pointer text-foreground">本地开发提示</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            需在 Google Cloud Console 登记{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              http://localhost:3000/api/auth/callback/google
            </code>{' '}
            为已授权重定向 URI。
          </li>
          <li>未在 ALLOWED_EMAIL_DOMAINS 的域名会被拒绝（?error=AccessDenied）。</li>
          <li>已禁用账号无法建立新 session。</li>
        </ul>
      </details>
    </div>
  );
}

/** Google 品牌标 —— 官方四色，不走主题 token（品牌色不应随主题变化）。 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.05l3.66 2.84c.87-2.6 3.3-4.51 6.16-4.51Z"
      />
    </svg>
  );
}
