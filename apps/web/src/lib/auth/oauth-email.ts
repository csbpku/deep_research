// OAuth 邮箱可信度校验：本系统按邮箱把 OAuth 登录关联到已有账号，
// 因此未验证邮箱必须拒绝，否则攻击者可在 IdP 注册受害者邮箱（未验证）后接管账号。

export type GithubEmailEntry = { email?: unknown; verified?: unknown; primary?: unknown };

/** Google：必须 email_verified === true（字符串 "true" 也不接受）。 */
export function isGoogleEmailVerified(profile: { email_verified?: unknown } | null | undefined): boolean {
  return profile?.email_verified === true;
}

/** GitHub：所选邮箱必须在 /user/emails 中且 verified === true。 */
export function isGithubEmailVerified(entries: unknown, chosenEmail: string): boolean {
  if (!Array.isArray(entries)) return false;
  const target = chosenEmail.trim().toLowerCase();
  return (entries as GithubEmailEntry[]).some(
    (entry) =>
      entry !== null
      && typeof entry === 'object'
      && typeof entry.email === 'string'
      && entry.email.toLowerCase() === target
      && entry.verified === true,
  );
}

/** 取 GitHub verified 邮箱列表；失败返回 null（调用方按拒绝处理）。 */
export async function fetchGithubEmails(accessToken: string): Promise<unknown[] | null> {
  try {
    const res = await fetch('https://api.github.com/user/emails', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'deep-research',
      },
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * OAuth 登录邮箱是否可信。非 google/github provider（如 credentials）不在此处理，返回 true。
 */
export async function isOAuthEmailTrusted(args: {
  provider: string | undefined;
  email: string;
  profile?: { email_verified?: unknown } | null;
  accessToken?: string | null;
  fetchEmails?: (token: string) => Promise<unknown[] | null>;
}): Promise<boolean> {
  if (args.provider === 'google') return isGoogleEmailVerified(args.profile);
  if (args.provider === 'github') {
    if (!args.accessToken) return false;
    const entries = await (args.fetchEmails ?? fetchGithubEmails)(args.accessToken);
    return entries !== null && isGithubEmailVerified(entries, args.email);
  }
  return true;
}
