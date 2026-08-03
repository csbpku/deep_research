import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * FilterBar —— 列表页顶部的筛选条（搜索框 + 下拉 + 提交）。
 * 迁移前 radar/page、researches/page、ai-research/page 各写一遍。
 *
 * 用 form 包裹，回车即提交；右侧 trailing 槽位放结果计数。
 */
export function FilterBar({
  onSubmit,
  children,
  trailing,
  className,
}: {
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
  children: React.ReactNode;
  /** 右侧附属信息，例如「共 128 条」 */
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className={cn(
        'mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3',
        className,
      )}
    >
      {children}
      {trailing ? (
        <div className="ml-auto text-xs tabular-nums text-muted-foreground">{trailing}</div>
      ) : null}
    </form>
  );
}
