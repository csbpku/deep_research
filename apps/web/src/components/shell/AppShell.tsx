import { Suspense } from 'react';

import { getCurrentUser } from '@/lib/auth/session';
import { ContextualShellBanner } from './ContextualShellBanner';
import { UnreadIssuesBanner } from './UnreadIssuesBanner';
import { Topbar } from './Topbar';
import { LoadingState } from '@/components/StateMessage';
// ⚠️ 必须从 server-safe 模块拿常量：从 './SidebarNav'（'use client'）拿会被 RSC
// 按 ID 序列化（而不是按值），导致 `[...PRIMARY_NAV]` 在服务端拿到字符串，
// 触发 "X is not iterable"。
import { ADMIN_NAV, PRIMARY_NAV, type NavItem } from './sidebar-nav-config';
import styles from './shell.module.css';

/**
 * AppShell —— 全站外壳（RSC）。
 *
 * 布局：顶部主导航 + 内容区。
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
  const navUser = user
    ? { email: user.email, name: user.name, image: user.image ?? null, role: user.role }
    : null;

  return (
    <div className={styles.shell}>
      <a href="#main-content" className={styles.skipLink}>跳到主要内容</a>
      <Topbar navItems={navItems} user={navUser} />
      <ContextualShellBanner>
        <Suspense fallback={null}>
          <UnreadIssuesBanner user={user} />
        </Suspense>
      </ContextualShellBanner>
      <main id="main-content" tabIndex={-1} className={styles.main}>
        {/* The RSC route slot may still be streaming when the client shell hydrates.
            Keep an explicit boundary around it, not only the nested loading.tsx. */}
        <Suspense fallback={<LoadingState label="正在加载页面…" />}>{children}</Suspense>
      </main>
    </div>
  );
}
