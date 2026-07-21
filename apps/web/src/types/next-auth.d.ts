// NextAuth v5 类型扩展 —— 在 callbacks 里把 id / role / disabledAt 注入 session.user。
//
// 仅在 apps/web 这一层扩展，不污染 packages/shared/（shared/ 是只读契约）。

import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: 'member' | 'admin';
      disabledAt: string | null;
    } & DefaultSession['user'];
  }

  interface User {
    role?: 'member' | 'admin';
    disabledAt?: Date | string | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string;
    role?: 'member' | 'admin';
    disabledAt?: string | null;
    email?: string;
    envHash?: string;
  }
}

export {};