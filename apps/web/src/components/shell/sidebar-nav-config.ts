// 侧栏导航数据 —— **server-safe** 模块（无 `'use client'`）。
//
// ⚠️ 不能从带 `'use client'` 的模块导出非组件常量：RSC 会在客户端边界
// 把这些常量丢失 / 设为 undefined，导致 server component 端 `[...PRIMARY_NAV]`
// 在运行时变成 "X is not iterable"。这条 Next.js 15 的硬规则。
//
// 把配置 + 类型放在这里；组件与图标运行时放在 SidebarNav.tsx 里。
//
// 研究库是沉淀入口；AI 调研是主动生产入口。

export type NavItemIconKey =
  | 'home'
  | 'radar'
  | 'research'
  | 'aiResearch'
  | 'search'
  | 'topic'
  | 'admin';

export interface NavItem {
  href: string;
  label: string;
  icon: NavItemIconKey;
}

export const PRIMARY_NAV: NavItem[] = [
  { href: '/radar', label: '技术雷达', icon: 'radar' },
  { href: '/topics', label: '技术专题', icon: 'topic' },
  { href: '/ai-research', label: 'AI 调研', icon: 'aiResearch' },
  { href: '/researches', label: '研究库', icon: 'research' },
];

export const ADMIN_NAV: NavItem = { href: '/admin', label: 'Admin', icon: 'admin' };

/**
 * P0/P1 状态标签 —— 当前不展示（用户要求删除），但保留结构方便以后
 * 有新入口需要标记时恢复。
 */
export const PILL_LABELS: Record<string, { label: string; className: string }> =
  {};

/** 当前 P1 但路由尚未落地的条目（mockup 有，代码暂无）。 */
export const PLACEHOLDER_P1: Array<{ href: string; label: string; icon: NavItemIconKey }> = [];

/** 首页只有精确匹配才算命中，其余按前缀。 */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
