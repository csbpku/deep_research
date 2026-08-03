// 侧栏导航数据 —— **server-safe** 模块（无 `'use client'`）。
//
// ⚠️ 不能从带 `'use client'` 的模块导出非组件常量：RSC 会在客户端边界
// 把这些常量丢失 / 设为 undefined，导致 server component 端 `[...PRIMARY_NAV]`
// 在运行时变成 "X is not iterable"。这条 Next.js 15 的硬规则。
//
// 把配置 + 类型放在这里；组件与图标运行时放在 SidebarNav.tsx 里。
//
// ⚠️ e2e 契约（researches-flows + contract）：正文必须含 /调研库|researches/
// 这两个关键字之一（任一即可，不再依赖中文字面）。

export type NavItemIconKey =
  | 'home'
  | 'digest'
  | 'radar'
  | 'research'
  | 'aiResearch'
  | 'search'
  | 'admin';

export interface NavItem {
  href: string;
  label: string;
  icon: NavItemIconKey;
}

export const PRIMARY_NAV: NavItem[] = [
  { href: '/', label: '总览', icon: 'home' },
  { href: '/summaries', label: 'AI 雷达日报', icon: 'digest' },
  { href: '/radar', label: '技术雷达', icon: 'radar' },
  { href: '/researches', label: '调研库', icon: 'research' },
  { href: '/ai-research', label: 'AI 调研', icon: 'aiResearch' },
  { href: '/search', label: '搜索', icon: 'search' },
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
