'use client';

import * as React from 'react';
import Link from 'next/link';
import { Menu, Telescope } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { SidebarNav, type NavItem } from './SidebarNav';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

/**
 * Topbar —— 顶栏（56px）。
 * 左：移动端汉堡（打开侧栏 Sheet）。右：主题切换 + 用户菜单。
 *
 * user 与 navItems 都是 RSC 传下来的纯数据，Topbar 自身不查询任何东西。
 */
export function Topbar({
  navItems,
  user,
}: {
  navItems: NavItem[];
  user: { email: string; name: string; role: 'member' | 'admin' } | null;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <header className="sticky top-0 z-40 flex h-topbar shrink-0 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      {/* 移动端侧栏 */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="打开导航">
            <Menu />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0 sm:max-w-xs">
          <SheetTitle className="sr-only">主导航</SheetTitle>
          <div className="flex h-topbar items-center gap-2 border-b border-border px-4">
            <Telescope className="size-4 text-primary" />
            <span className="text-sm font-semibold tracking-tight">技术调研</span>
          </div>
          <div className="p-2">
            <SidebarNav items={navItems} onNavigate={() => setMobileOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      {/* 移动端上侧栏隐藏，这里补一个品牌位 */}
      <Link href="/" className="flex items-center gap-2 md:hidden">
        <span className="text-sm font-semibold tracking-tight">技术调研</span>
      </Link>

      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
        <UserMenu user={user} />
      </div>
    </header>
  );
}
