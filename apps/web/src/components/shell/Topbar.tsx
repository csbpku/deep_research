'use client';

// Topbar —— 顶栏（56px）。
// 左：移动端汉堡（打开侧栏 Sheet）。右：全局搜索 + 新建 + AI 调研进行中
//   指示器 + 主题切换 + 用户菜单。
//
// user 与 navItems 都是 RSC 传下来的纯数据，Topbar 自身不查询 nav；只有
// 搜索框和 AI 调研指示器是 client-side 的。

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { FilePenLine, Loader2, Menu, Search as SearchIcon, Telescope } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
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
  return (
    <button
      type="button"
      onClick={() => router.push(`/ai-research/${job.jobId}`)}
      aria-label={`查看调研进度：${job.topic}`}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Loader2 className="size-3 animate-spin text-status-running-fg" />
      <span className="hidden max-w-[140px] truncate sm:inline">{job.topic}</span>
      <span className="sm:hidden">调研中</span>
    </button>
  );
}

/** 顶栏全局搜索框：轻量版 —— 回车跳转 /search?q=...，⌘K / Ctrl K 聚焦。 */
function GlobalSearchBox() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [q, setQ] = React.useState(searchParams.get('q') ?? '');

  // 离开 /search 时把本地输入清空；进入 /search 时同步 URL。
  React.useEffect(() => {
    setQ(searchParams.get('q') ?? '');
  }, [searchParams]);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
      const trigger = isMac ? e.metaKey : e.ctrlKey;
      if (trigger && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = q.trim();
    if (!trimmed) return;
    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <form onSubmit={submit} className="hidden flex-1 sm:block" role="search">
      <label htmlFor="topbar-search" className="sr-only">全局搜索</label>
      <div className="relative mx-auto w-full max-w-md">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="topbar-search"
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索雷达、摘要、调研库…（⌘K）"
          aria-label="全局搜索"
          className="h-8 w-full pl-7 pr-12 text-sm"
        />
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-muted/40 px-1 font-mono text-[10px] text-muted-foreground sm:inline">
          ⌘K
        </kbd>
      </div>
    </form>
  );
}

function PageContext({ navItems }: { navItems: NavItem[] }) {
  const pathname = usePathname();
  const current = navItems.find((item) => (
    item.href === '/'
      ? pathname === '/'
      : pathname === item.href || pathname.startsWith(`${item.href}/`)
  ));
  if (!current) return null;
  return (
    <span className="hidden shrink-0 border-r border-border pr-3 text-sm font-medium text-foreground lg:inline">
      {current.label}
    </span>
  );
}

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

      {/* 移动端品牌位 */}
      <Link href="/" className="flex items-center gap-2 md:hidden">
        <span className="text-sm font-semibold tracking-tight">技术调研</span>
      </Link>

      <PageContext navItems={navItems} />
      <GlobalSearchBox />

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* AI 调研进行中（仅登录用户才可能返回非空） */}
        {user ? <AiResearchIndicator /> : null}

        {/* 新建调研 */}
        {user ? (
          <Button asChild variant="ghost" size="icon-sm" aria-label="新建调研">
            <Link href="/researches/new">
              <FilePenLine />
            </Link>
          </Button>
        ) : null}

        <ThemeToggle />
        <UserMenu user={user} />
      </div>
    </header>
  );
}
