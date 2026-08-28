'use client';

// Topbar —— 顶部主导航（56px）。
// 桌面：品牌 + 主导航 + 全局搜索；移动：汉堡导航 + 品牌 + 工具。
//   + 主题切换 + 用户菜单。
//
// user 与 navItems 都是 RSC 传下来的纯数据，Topbar 自身不查询 nav；只有
// 搜索框和 AI 调研指示器是 client-side 的。

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Menu, Search as SearchIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { BrandMark } from './BrandMark';
import { SidebarNav, type NavItem } from './SidebarNav';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

interface AiJobsResponse {
  items: Array<{
    jobId: string;
    topic: string;
    status: string;
    finalStatus: string | null;
  }>;
}

/** 顶部 AI 调研进行中指示器：只在有 in-flight 任务时显示。 */
function AiResearchIndicator() {
  const router = useRouter();
  const { data } = useQuery<AiJobsResponse>({
    queryKey: ['topbar', 'ai-research', 'in-flight'],
    queryFn: async () => {
      const r = await fetch('/api/ai-research/jobs?status=queued,running&limit=1', {
        cache: 'no-store',
      });
      if (!r.ok) return { items: [] };
      return r.json();
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  const job = data?.items?.[0];
  if (!job) return null;
  /* AI 调研进行中指示器：触控目标 ≥ 36px，移动端仍可达 */
  return (
    <button
      type="button"
      onClick={() => router.push(`/ai-research/${job.jobId}`)}
      aria-label={`查看调研进度：${job.topic}`}
      className="inline-flex h-9 min-h-[36px] items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Loader2 className="size-3 animate-spin text-status-running-fg" />
      <span className="hidden max-w-[140px] truncate sm:inline">{job.topic}</span>
      <span className="sm:hidden">调研中</span>
    </button>
  );
}

/**
 * 顶栏搜索命令入口：完整检索留在 /search，顶栏只承担快速进入。
 * ⌘K / Ctrl+K 在任意页面都打开完整搜索页，避免顶栏输入框挤占阅读空间。
 */
function GlobalSearchCommand() {
  const router = useRouter();

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
      const trigger = isMac ? e.metaKey : e.ctrlKey;
      if (trigger && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        router.push('/search');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  return (
    <>
      {/* 桌面端 ⌘K 触发器（sm 以上显示） */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => router.push('/search')}
        aria-label="打开全局搜索（⌘K）"
        aria-keyshortcuts="Meta+K Control+K"
        className="hidden h-9 min-w-0 gap-2 px-2.5 text-muted-foreground sm:flex sm:w-52 sm:justify-start"
      >
        <SearchIcon className="size-3.5" />
        <span className="truncate text-xs">搜索研究内容</span>
        <kbd className="ml-auto rounded border border-border bg-muted/50 px-1 font-mono text-[10px] text-muted-foreground">
          ⌘K
        </kbd>
      </Button>

      {/* 移动端 icon-only 搜索入口（&lt;sm 显示）—— 触控目标 44×44 */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => router.push('/search')}
        aria-label="打开搜索"
        aria-keyshortcuts="Meta+K Control+K"
        className="h-11 w-11 sm:hidden"
      >
        <SearchIcon className="size-4" />
      </Button>
    </>
  );
}

export function Topbar({
  navItems,
  user,
}: {
  navItems: NavItem[];
  user: { email: string; name: string; image: string | null; role: 'member' | 'admin' } | null;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <header className="sticky top-0 z-40 flex h-topbar shrink-0 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <Link href="/" className="hidden shrink-0 items-center gap-2 md:flex" aria-label="AI技术调研平台首页">
        <BrandMark className="size-6" />
        <span className="hidden text-sm font-semibold tracking-normal lg:inline">AI技术调研平台</span>
      </Link>

      {/* 移动端侧栏 */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetTrigger asChild>
          {/* 触控目标 44×44（避免小屏难命中） */}
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11 md:hidden"
            aria-label="打开导航"
          >
            <Menu />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0 sm:max-w-xs">
          <SheetTitle className="sr-only">主导航</SheetTitle>
          <SheetDescription className="sr-only">
            切换专题、调研库、搜索、设置等主要功能区
          </SheetDescription>
          <div className="flex h-topbar items-center gap-2 border-b border-border px-4">
            <BrandMark />
            <span className="text-sm font-semibold tracking-normal">AI技术调研平台</span>
          </div>
          <div className="p-2">
            <SidebarNav items={navItems} onNavigate={() => setMobileOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      {/* 移动端品牌位 */}
      <Link href="/" className="flex min-w-0 items-center gap-2 md:hidden" aria-label="AI技术调研平台首页">
        <BrandMark className="size-6" />
        <span className="truncate text-sm font-semibold tracking-normal">AI技术调研平台</span>
      </Link>

      <div className="hidden min-w-0 flex-1 overflow-x-auto md:block">
        <SidebarNav items={navItems} horizontal />
      </div>

      <GlobalSearchCommand />

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* AI 调研进行中（仅登录用户才可能返回非空） */}
        {user ? <AiResearchIndicator /> : null}

        <ThemeToggle />
        <UserMenu user={user} />
      </div>
    </header>
  );
}
