'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Flame,
  LayoutGrid,
  Library,
  Newspaper,
  Radar,
  Search,
  Settings,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  isNavActive,
  PILL_LABELS,
  type NavItem,
  type NavItemIconKey,
} from './sidebar-nav-config';

// 重导出：保持原有 `import { PRIMARY_NAV, ADMIN_NAV, SidebarNav, type NavItem } from './SidebarNav'`
// 的调用点仍可用，避免一次性改一片 import。
export type { NavItem } from './sidebar-nav-config';
export {
  PRIMARY_NAV,
  ADMIN_NAV,
  PILL_LABELS,
  PLACEHOLDER_P1,
} from './sidebar-nav-config';

/**
 * 图标按名字查表，名字类型由 server-safe 模块的 NavItemIconKey 锁定。
 * 这样 server 模块只能引用 NavItemIconKey 里存在的 key，类型系统杜绝 typo。
 */
const ICONS: Record<NavItemIconKey, LucideIcon> = {
  home: LayoutGrid,
  digest: Newspaper,
  radar: Radar,
  // 调研库用书架图标：长期归档而非主动创造
  research: Library,
  // AI 调研用流程图：5 步流水线（plan → search → compress → analyze → write）
  aiResearch: Workflow,
  search: Search,
  // 热点主题用 Flame：视觉上比 Radar 更"热度感"，便于和雷达区分
  topic: Flame,
  admin: Settings,
};

/**
 * SidebarNav —— 极薄 client island。
 * 唯一的职责：usePathname() 打 aria-current + 高亮。
 * 角色判断留在 RSC 侧（AppShell），这里只渲染传进来的条目。
 */
export function SidebarNav({
  items,
  onNavigate,
}: {
  items: NavItem[];
  /** 移动端 Sheet 里点击后收起 */
  onNavigate?: () => void;
}) {
  const pathname = usePathname() ?? '/';

  return (
    <nav className="flex flex-col gap-0.5" aria-label="主导航">
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = isNavActive(pathname, item.href);
        const pill = PILL_LABELS[item.href];
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              // 左侧 2px 高亮条：给 active 状态更强的视觉权重
              'group relative flex items-center gap-2.5 rounded-md py-2 pl-3.5 pr-2.5 text-[13px] transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-transparent before:transition-colors before:duration-150',
              active
                ? 'bg-accent font-medium text-accent-foreground before:bg-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground hover:before:bg-muted-foreground/30',
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{item.label}</span>
            {pill && (
              <span
                className={cn(
                  'ml-auto rounded px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                  pill.className,
                )}
              >
                {pill.label}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
