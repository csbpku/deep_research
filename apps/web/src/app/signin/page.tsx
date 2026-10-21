import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { space } from '@deep-research/design-system';
import { AppButton } from '@/components/material/AppButton';
import { signIn } from '@/lib/auth/config';
import { getWebEnv } from '@/lib/env';
import { isProductionAuthAllowed } from '@/lib/auth/transport';
import { safeInternalCallbackUrl } from '@/lib/auth/callback-url';
import { Github } from 'lucide-react';
import { headers } from 'next/headers';
import { PasswordAuthForms } from './PasswordAuthForms';

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
  const requestHeaders = await headers();
  const error = sp?.error;
  const env = getWebEnv();
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const githubConfigured = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  const googleOnly = env.AUTH_GOOGLE_ONLY;
  const betaMode = env.AUTH_BETA_MODE;
  const emailVerification = env.AUTH_EMAIL_VERIFICATION;
  const isDevMode = process.env.NODE_ENV !== 'production';
  const authAllowed = isProductionAuthAllowed(
    requestHeaders,
    env.NODE_ENV,
    undefined,
    env.AUTH_ALLOW_INSECURE_HTTP,
  );
  // W9 安全复审修订（S0）：此前 searchParams.callbackUrl 直接喂给
  // signIn('google', { redirectTo: callbackUrl })，无任何域名/路径校验，
  // 攻击者可构造 /signin?callbackUrl=https://evil.com 做开放重定向钓鱼。
  // Parse instead of checking only the first slash: `//host/path` is external.
  const callbackUrl = safeInternalCallbackUrl(sp?.callbackUrl);

  async function doSignIn() {
    'use server';
    if (!googleConfigured) return;
    await signIn('google', { redirectTo: callbackUrl });
  }

  async function doGithubSignIn() {
    'use server';
    if (!githubConfigured) return;
    await signIn('github', { redirectTo: callbackUrl });
  }

  return (
    <Box component="div" sx={{ width: '100%', maxWidth: '480px', marginInline: 'auto', paddingBlock: { xs: space.lg, sm: space.wide }, paddingInline: { xs: space.md, sm: space.lg } }}>
      <Stack component="section" aria-labelledby="signin-title" sx={{ gap: space.lg }}>
        <Stack component="header" sx={{ gap: space.sm, textAlign: 'center', paddingInline: { xs: 0, sm: space.md } }}>
          <Typography id="signin-title" component="h1" variant="pageTitle">登录</Typography>
          <Typography component="p" variant="body1" color="text.secondary">
            {
            googleOnly
              ? '使用 Google 登录。'
              : googleConfigured && githubConfigured
                ? '使用 Google、GitHub，或邮箱密码登录。'
                : googleConfigured
                  ? '使用 Google 或邮箱密码登录。'
                  : githubConfigured
                    ? '使用 GitHub 或邮箱密码登录。'
                    : '使用邮箱和密码登录。'
            }
          </Typography>
        </Stack>
      {error ? (
        <Alert severity="error" variant="outlined" sx={{ textAlign: 'left', borderRadius: 'var(--dr-radius-medium)' }}>
          {error === 'AccessDenied'
            ? betaMode
              ? '当前为 Beta 测试，仅限管理员白名单中的邮箱登录。'
              : googleOnly
              ? 'Google 账号未能完成登录，或账号已被禁用。'
              : 'OAuth 账号未能完成登录，或账号已被禁用。'
            : '登录失败，请稍后重试或检查账号信息。'}
        </Alert>
      ) : null}
      {!googleOnly && authAllowed ? (
        <PasswordAuthForms
          callbackUrl={callbackUrl}
          betaMode={betaMode}
          emailVerification={emailVerification}
        />
      ) : !googleOnly ? (
        <Alert severity="warning" variant="outlined" sx={{ textAlign: 'left', borderRadius: 'var(--dr-radius-medium)' }}>
          当前连接未启用 HTTPS。为保护密码和会话，邮箱密码登录与邀请码激活已暂停，请先通过 HTTPS 访问本站。
        </Alert>
      ) : null}
      {authAllowed && (googleConfigured || githubConfigured) ? (
        <Stack component="section" aria-label="其他登录方式" sx={{ gap: space.md }}>
          <Divider />
          {googleConfigured ? (
            <form action={doSignIn}>
              <AppButton type="submit" variant="outlined" size="large" fullWidth>
                <GoogleMark />
                使用 Google 登录
              </AppButton>
            </form>
          ) : null}
          {githubConfigured ? <Box component="form" action={doGithubSignIn}>
              <AppButton type="submit" variant="outlined" size="large" fullWidth>
                <Github aria-hidden />
                使用 GitHub 登录
              </AppButton>
            </Box> : null}
        </Stack>
      ) : authAllowed && isDevMode && !googleOnly && !googleConfigured && !githubConfigured ? (
        <Typography component="p" variant="metadata" color="text.secondary" sx={{ textAlign: 'center' }}>OAuth 尚未配置，当前使用邮箱密码登录。</Typography>
      ) : googleOnly && !googleConfigured ? (
        <Alert severity="error" variant="outlined" sx={{ textAlign: 'left', borderRadius: 'var(--dr-radius-medium)' }}>
          Google OAuth 尚未配置，当前无法登录。
        </Alert>
      ) : null}
      </Stack>
    </Box>
  );
}

/** Google 品牌标 —— 官方四色，不走主题 token（品牌色不应随主题变化）。 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden style={{ width: 16, height: 16 }}>
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
