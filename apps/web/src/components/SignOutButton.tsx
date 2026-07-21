'use client';

import { signOut } from 'next-auth/react';

/**
 * 仅登出按钮是 client（调 next-auth/react signOut）。
 * 其余 nav 逻辑在 Nav.tsx (RSC) 里，避免整个 nav 变成 client component。
 */
export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: '/signin' })}
      style={{ border: '1px solid #cbd5e1', background: '#fff', padding: '4px 10px', borderRadius: 4 }}
    >
      登出
    </button>
  );
}