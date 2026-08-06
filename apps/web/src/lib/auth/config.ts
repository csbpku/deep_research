// NextAuth v5 配置 —— Google OAuth + JWT 策略。
//
// 关键决策（Week 1 复评 ADR 0002 + 当前 schema freeze）：
//   - schema 已 freeze，且**没有** Account / Session / VerificationToken 表。
//   - @auth/prisma-adapter 需要这三张表，接入会违反「不许改 schema」约束。
//   - 因此 NextAuth 使用 JWT strategy（无 DB adapter），用户身份在 jwt callback
//     里读 DB 注入；session callback 把 id / role / disabledAt 透传到 session.user。
//   - signIn callback 做邮箱 allowlist + disabledAt 双重校验，未通过直接 false，
//     NextAuth 会跳到 ?error=AccessDenied 页面。
//
// E2E 模式（process.env.E2E === '1'）：额外启用 Credentials provider
//   允许用 email 直登，方便 Playwright 注入 session。
//
// 注意：env 解析在 lib/env.ts 完成；本文件只引用 getWebEnv()。

import NextAuth, { type NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import { getWebEnv } from '../env';
import { prisma } from '../db';
import { canEstablishSession, isEmailAllowed } from './allowlist';
import { log } from '../log';

const isE2E = process.env.E2E === '1';

export const authConfig: NextAuthConfig = {
  providers: [
    ...(isE2E
      ? [
          Credentials({
            id: 'e2e-credentials',
            name: 'E2E Test Login',
            credentials: {
              email: { label: 'Email', type: 'email' },
              role: { label: 'Role', type: 'text' },
            },
            async authorize(credentials) {
              const email = (credentials?.email as string | undefined)?.toLowerCase();
              const role = (credentials?.role as 'member' | 'admin' | undefined) ?? 'member';
              if (!email) return null;
              const env = getWebEnv();
              // This provider exists only for local Playwright runs. Its fixture
              // address must not be constrained by the production Google
              // allowlist; Google OAuth still follows the normal check below.
              if (!isE2E && !isEmailAllowed(email, env.ALLOWED_EMAIL_DOMAINS)) return null;
              const u = await prisma.user.upsert({
                where: { email },
                create: { email, name: email.split('@')[0], role },
                update: { name: email.split('@')[0], role },
              });
              if (!canEstablishSession(u)) return null;
              return {
                id: u.id,
                email: u.email,
                name: u.name,
                role: u.role,
                image: u.avatarUrl,
                disabledAt: u.disabledAt,
              };
            },
          }),
        ]
      : []),
    Google({
      clientId: getWebEnv().GOOGLE_CLIENT_ID,
      clientSecret: getWebEnv().GOOGLE_CLIENT_SECRET,
      // 强制提供 email + profile；allowlist 校验依赖 email
      authorization: {
        params: {
          prompt: 'consent',
          access_type: 'offline',
          scope: 'openid email profile',
        },
      },
    }),
  ],
  // JWT session；详见文件头注释。maxAge 与 cookie 名走 NextAuth 默认。
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 7 },
  trustHost: true,
  pages: {
    signIn: '/signin',
    error: '/signin',
  },
  callbacks: {
    /**
     * Google OAuth callback 进入前的校验。返回 false → NextAuth 跳到 ?error=AccessDenied。
     *
     * 不允许的邮箱域、被禁用账号都拒绝。不在 allowlist 的邮箱连 User 都不创建。
     */
    async signIn({ user, profile, account }) {
      const email = user.email ?? profile?.email ?? null;
      if (!email) {
        log.warn('auth.signin', 'no email in profile', { provider: account?.provider });
        return false;
      }
      const env = getWebEnv();
      // E2E credentials are an explicit local-test-only provider; its fixture
      // domain must not depend on the production Google allowlist. This branch
      // is unreachable unless the web server was started with E2E=1.
      if (!(isE2E && account?.provider === 'e2e-credentials') && !isEmailAllowed(email, env.ALLOWED_EMAIL_DOMAINS)) {
        log.warn('auth.signin', 'domain not allowed', {
          provider: account?.provider,
          domain: email.split('@')[1]?.toLowerCase() ?? '',
        });
        return false;
      }
      // 已存在用户：检查 disabledAt；不存在用户：交给下面的 jwt callback 首次创建。
      const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (!canEstablishSession(existing)) {
        log.warn('auth.signin', 'account disabled', { email: email.toLowerCase() });
        return false;
      }
      return true;
    },

    /**
     * JWT 注入。每当新 session 创建或现有 token 触发刷新时调用。
     * 首次登录（user 非空）时从 DB 读 user 注入 uid/role/disabledAt。
     * 后续请求（user 为空）也再读一次 DB，让 admin 设的 disable 立即生效。
     */
    async jwt({ token, user }) {
      const env = getWebEnv();
      if (user?.email) {
        // 首次登录；upsert User（不在 signIn 内做是为了让 signIn 失败时 DB 干净）
        const email = user.email.toLowerCase();
        const u = await prisma.user.upsert({
          where: { email },
          create: {
            email,
            name: user.name ?? email.split('@')[0],
            avatarUrl: user.image ?? null,
            role: 'member',
          },
          update: {
            name: user.name ?? undefined,
            avatarUrl: user.image ?? undefined,
          },
        });
        token.uid = u.id;
        token.role = u.role;
        token.disabledAt = u.disabledAt ? u.disabledAt.toISOString() : null;
        token.email = email;
        token.envHash = envHash(env);
      } else if (typeof token.uid === 'string') {
        // 后续请求；重新读一次 user（admin 禁用立即生效；性能开销可接受）
        const u = await prisma.user.findUnique({ where: { id: token.uid } });

        // W9 安全复审修订：envHash 此前写入 JWT 但从不校验。
        // secret / GOOGLE_CLIENT_ID 轮换后旧 JWT 继续有效直到 7 天自然过期。
        // 现在在每次后续请求上比对；env 变化 → 立即失效登出。
        if (token.envHash && token.envHash !== envHash(env)) {
          return null as unknown as typeof token;
        }

        if (!u) {
          // user row 缺失（不应发生）；清空 token 触发登出
          return null as unknown as typeof token;
        }
        token.role = u.role;
        token.disabledAt = u.disabledAt ? u.disabledAt.toISOString() : null;
        if (!isAccountActiveForSession(u.disabledAt)) {
          // 已被禁用；返回 null 让 NextAuth 终止 session
          return null as unknown as typeof token;
        }
      }
      return token;
    },

    /**
     * 把 token 里的字段复制到 session.user，方便 BFF 用 session.user.id / .role。
     * disabledAt 透传是为了让 getCurrentUser() 在 helper 里再次校验（避免 jwt 阶段漏判）。
     *
     * JWT 策略下，session callback 拿到的是 { session, token }；user 字段仅 database 策略可用。
     */
    async session({ session, token }) {
      if (typeof token.uid === 'string') session.user.id = token.uid;
      if (token.role === 'admin' || token.role === 'member') session.user.role = token.role;
      session.user.disabledAt = (token.disabledAt as string | null) ?? null;
      if (typeof token.email === 'string') session.user.email = token.email;
      return session;
    },
  },
  events: {
    async signIn(message) {
      log.info('auth.signin', 'session established', {
        provider: message.account?.provider,
        isNewUser: Boolean(message.isNewUser),
        userId: typeof message.user?.id === 'string' ? message.user.id : undefined,
      });
    },
    async signOut(message) {
      const userId =
        'token' in message && message.token && typeof message.token.uid === 'string'
          ? message.token.uid
          : undefined;
      log.info('auth.signout', 'session ended', { userId });
    },
  },
};

function isAccountActiveForSession(disabledAt: Date | null): boolean {
  return disabledAt === null;
}

function envHash(env: { GOOGLE_CLIENT_ID: string; NEXTAUTH_SECRET: string }): string {
  // 把 env 关键字段拼成短 hash，env 变化时让旧 token 失效；避免 secret 轮换后旧 JWT 残留。
  // 这里只用 env 字段，不引入 hash 库，保持依赖最小。
  let h = 0;
  const s = env.GOOGLE_CLIENT_ID + '|' + env.NEXTAUTH_SECRET;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
