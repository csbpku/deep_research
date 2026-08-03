import Link from 'next/link';
import { Telescope } from 'lucide-react';

import { getCurrentUser } from '@/lib/auth/session';
import { Topbar } from './Topbar';
import { SidebarNav } from './SidebarNav';
// ⚠️ 必须从 server-safe 模块拿常量：从 './SidebarNav'（'use client'）拿会被 RSC
// 按 ID 序列化（而不是按值），导致 `[...PRIMARY_NAV]` 在服务端拿到字符串，
// 触发 "X is not iterable"。
import { ADMIN_NAV, PRIMARY_NAV, type NavItem } from './sidebar-nav-config';

/**
 * AppShell —— 全站外壳（RSC）。
 *
 * 布局：左侧固定侧栏 240px（md 以下收进 Topbar 的 Sheet）+ 右侧顶栏 56px + 内容区。
 * 内容区宽度由各页面自己用 `max-w-shell`（列表/控制台，1280px）或
 * `max-w-measure`（详情/长文，760px）决定，这里不设死。
 *
 * 角色判断留在服务端：Admin 入口的显隐只是体验，真正的闸门仍是
 * requireAdmin()（直链 /admin 依旧会被服务端拒绝）。
 *
 * 本组件取代了原来的 Nav.tsx。
 */
export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const isAdmin = user?.role === 'admin';

  const navItems: NavItem[] = isAdmin ? [...PRIMARY_NAV, ADMIN_NAV] : PRIMARY_NAV;

  // 传给 client 组件的必须是可序列化的纯数据。
  const navUser = user ? { email: user.email, name: user.name, role: user.role } : null;

  return (
    <div className="flex min-h-screen">
      {/* 桌面侧栏 */}
      <aside className="sticky top-0 hidden h-screen w-sidebar shrink-0 flex-col border-r border-border bg-card md:flex">
        <Link
          href="/"
          className="flex h-topbar shrink-0 items-center gap-2 border-b border-border px-4 transition-colors hover:bg-muted/50"
        >
          <Telescope className="size-4 shrink-0 text-primary" />
          <span className="text-sm font-semibold tracking-tight">技术调研</span>
        </Link>

        <div className="flex-1 overflow-y-auto p-2">
          <SidebarNav items={navItems} />
        </div>

        <div className="shrink-0 border-t border-border px-4 py-2.5">
          <p className="text-[11px] text-muted-foreground">研究工作台 · 内部预览版</p>
        </div>
      </aside>

      {/* 主列 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar navItems={navItems} user={navUser} />
        <main className="flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
