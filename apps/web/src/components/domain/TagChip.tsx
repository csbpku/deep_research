import * as React from 'react';
import Link from 'next/link';

import { cn } from '@/lib/utils';

/**
 * TagChip —— 标签胶囊。
 * 迁移前 RadarCandidateCard / researches/page / researches/[id]/page 各写一遍。
 * 传 href 时渲染成可点链接（用于按标签筛选）。
 */
export function TagChip({
  children,
  href,
  className,
}: {
  children: React.ReactNode;
  href?: string;
  className?: string;
}) {
  const base = cn(
    'inline-flex items-center rounded px-1.5 py-0.5 font-mono text-xs text-muted-foreground',
    'bg-muted transition-colors duration-150',
    href && 'cursor-pointer hover:bg-accent hover:text-accent-foreground',
    className,
  );

  if (href) {
    return (
      <Link href={href} className={base}>
        {children}
      </Link>
    );
  }
  return <span className={base}>{children}</span>;
}

/** 标签组容器：自动换行 + 一致间距。 */
export function TagList({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)} {...props}>
      {children}
    </div>
  );
}
