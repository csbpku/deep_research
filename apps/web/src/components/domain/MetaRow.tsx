import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * MetaRow —— 详情页的「作者 · 日期 · 计数」元信息行。
 * 迁移前 researches/[id]、summaries/[id]、radar/[id] 各写了一遍。
 */
export function MetaRow({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground',
        '[&_svg]:size-3.5 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** 单项元信息：可选图标 + 文本。多项之间由 MetaRow 的 gap 分隔。 */
export function MetaItem({
  icon,
  children,
  mono = false,
  className,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  /** ID / 数值类用等宽字体 */
  mono?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1', mono && 'font-mono', className)}>
      {icon}
      {children}
    </span>
  );
}
