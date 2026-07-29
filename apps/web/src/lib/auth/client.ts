'use client';

// 客户端 React hook：获取当前登录用户。
//
// 用途：UI 组件需要根据当前用户判断是否显示"删除"、"AI 讨论"、"Admin" 等入口。
// 数据源：`/api/auth/session`（NextAuth 标准端点）。
//
// P0 范围：仅用于 UI 显隐和"作者可删除自己"判断；权限/资源所有权校验全部由 BFF
// 二次把关，绝不能信任客户端返回的 user。

import { useQuery } from '@tanstack/react-query';

interface ClientSessionUser {
  id: string;
  email: string;
  name: string;
  role: 'member' | 'admin';
  disabledAt: string | null;
}

interface SessionResponse {
  user: ClientSessionUser | null;
}

export function useCurrentUser() {
  return useQuery<{ id: string; name: string; role: 'member' | 'admin' } | null>({
    queryKey: ['current-user'],
    queryFn: async () => {
      const r = await fetch('/api/auth/session', { cache: 'no-store' });
      if (!r.ok) return null;
      const data = (await r.json()) as SessionResponse;
      return data.user
        ? { id: data.user.id, name: data.user.name, role: data.user.role }
        : null;
    },
    staleTime: 30_000,
  });
}