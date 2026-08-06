import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * PageHeader —— 页面标题区。
 * 迁移前 radar / researches / ai-research / search / summaries 五个列表页
 * 各自内联写了一遍 h1 + 描述段。
 *
 * ⚠️ e2e 依赖 h1 可见 + 标题中的关键字（调研库 / 雷达 / 日报 / AI 调研），
 * 迁移时不要改文案。
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 右侧操作区（新建按钮等） */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0 space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-normal sm:text-[30px] sm:leading-tight">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-sm leading-7 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
