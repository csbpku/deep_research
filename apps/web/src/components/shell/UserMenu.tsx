'use client';

import Link from 'next/link';
import { signOut } from 'next-auth/react';
import {
  Bookmark,
  ChevronDown,
  FilePenLine,
  LogIn,
  LogOut,
  Pin,
  Settings as SettingsIcon,
  ShieldCheck,
  User,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { researchTabHref } from '@/lib/research-tabs';

/**
 * 用户菜单 —— 顶栏右侧。
 * 用户对象由 RSC（Sidebar/AppShell）读 getCurrentUser() 后作为纯数据传入，
 * 这里只做展示与登出，不自己发请求。
 *
 * ⚠️ e2e 依赖未登录时正文出现「登录」字样（public-flows.spec.ts）。
 */
export function UserMenu({
  user,
}: {
  user: { email: string; name: string; role: 'member' | 'admin' } | null;
}) {
  if (!user) {
    return (
      <Button asChild size="sm">
        <Link href="/signin">
          <LogIn />
          登录
        </Link>
      </Button>
    );
  }

  const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 px-1.5"
          aria-label="打开用户菜单"
        >
          <Avatar className="size-7">
            <AvatarFallback>{initial}</AvatarFallback>
          </Avatar>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <div className="flex items-center gap-2 text-foreground">
            <User className="size-4 text-muted-foreground" />
            <span className="truncate text-sm">{user.name || user.email}</span>
          </div>
          <div className="mt-1 truncate pl-6 font-mono text-xs text-muted-foreground">
            {user.email}
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />
        <DropdownMenuLabel>我的内容</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href={researchTabHref('draft')}>
            <FilePenLine />
            我的草稿
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/me/favorites">
            <Bookmark />
            我的收藏
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/me/topics">
            <Pin />
            我的主题关注
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/me/settings">
            <SettingsIcon />
            个人设置
          </Link>
        </DropdownMenuItem>

        {user.role === 'admin' ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/admin">
                <ShieldCheck />
                Admin 控制台
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => signOut({ callbackUrl: '/signin' })}>
          <LogOut />
          登出
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
