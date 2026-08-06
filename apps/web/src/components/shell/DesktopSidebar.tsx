'use client';

import * as React from 'react';
import Link from 'next/link';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { BrandMark } from './BrandMark';
import { SidebarNav, type NavItem } from './SidebarNav';

const STORAGE_KEY = 'research-shell-sidebar-collapsed';
const WIDTH_STORAGE_KEY = 'research-shell-sidebar-width';
const MIN_WIDTH = 180;
const MAX_WIDTH = 360;

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));
}

export function DesktopSidebar({ items }: { items: NavItem[] }) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [width, setWidth] = React.useState(240);
  const resizing = React.useRef(false);

  React.useEffect(() => {
    setCollapsed(window.localStorage.getItem(STORAGE_KEY) === 'true');
    const storedWidth = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY));
    if (Number.isFinite(storedWidth)) setWidth(clampWidth(storedWidth));
  }, []);

  React.useEffect(() => {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  }, [width]);

  React.useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!resizing.current) return;
      setWidth(clampWidth(event.clientX));
    };
    const onPointerUp = () => {
      resizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  function toggle() {
    setCollapsed((value) => {
      const next = !value;
      window.localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }

  function adjustWidth(delta: number) {
    setWidth((current) => {
      const next = clampWidth(current + delta);
      window.localStorage.setItem(WIDTH_STORAGE_KEY, String(next));
      return next;
    });
  }

  return (
    <aside style={{ width: collapsed ? 56 : width }} className="relative sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-background transition-[width] duration-200 md:flex">
      <div className={`flex h-topbar shrink-0 items-center border-b border-border ${collapsed ? 'justify-center px-2' : 'gap-2 px-4'}`}>
        <Link href="/" className="flex min-w-0 items-center gap-2" aria-label="AI技术调研平台首页">
          <BrandMark />
          {!collapsed ? <span className="truncate text-sm font-semibold tracking-normal">AI技术调研平台</span> : null}
        </Link>
      </div>

      <div className={`flex-1 overflow-y-auto ${collapsed ? 'p-2' : 'p-2'}`}>
        <SidebarNav items={items} collapsed={collapsed} />
      </div>

      <div className={`shrink-0 border-t border-border ${collapsed ? 'flex justify-center p-2' : 'flex items-center justify-between gap-2 px-4 py-3'}`}>
        {!collapsed ? <p className="text-[11px] text-muted-foreground">小型团队 · 共享研究空间</p> : null}
        <Button type="button" variant="ghost" size="icon-sm" onClick={toggle} aria-label={collapsed ? '展开总览导航' : '收起总览导航'} title={collapsed ? '展开导航' : '收起导航'}>
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>
      </div>
      {!collapsed ? <button
        type="button"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整总览导航宽度"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        title="拖动调整总览导航宽度；方向键微调"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); adjustWidth(-16); }
          if (event.key === 'ArrowRight') { event.preventDefault(); adjustWidth(16); }
          if (event.key === 'Home') { event.preventDefault(); setWidth(MIN_WIDTH); window.localStorage.setItem(WIDTH_STORAGE_KEY, String(MIN_WIDTH)); }
          if (event.key === 'End') { event.preventDefault(); setWidth(MAX_WIDTH); window.localStorage.setItem(WIDTH_STORAGE_KEY, String(MAX_WIDTH)); }
        }}
        onPointerDown={(event) => { event.preventDefault(); resizing.current = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; }}
        className="absolute -right-2 top-0 z-10 hidden h-full w-4 cursor-col-resize md:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      ><span className="mx-auto block h-full w-px bg-transparent transition-colors hover:bg-border" /></button> : null}
    </aside>
  );
}
