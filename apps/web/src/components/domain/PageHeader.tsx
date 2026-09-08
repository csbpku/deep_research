import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * PageHeader —— 页面标题区。
 * 迁移前 radar / researches / ai-research / search / summaries 五个列表页
 * 各自内联写了一遍 h1 + 描述段。
 *
 * ⚠️ e2e 依赖 h1 可见 + 标题中的关键字（调研库 / 雷达 / AI 调研），
 * 迁移时不要改文案。
 */
export function PageHeader({
  title,
  description,
  actions,
  variant = 'browse',
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 右侧操作区（新建按钮等） */
  actions?: React.ReactNode;
  /** 页面任务语气：浏览、工作台，或更紧凑的阅读上下文。 */
  variant?: 'browse' | 'workbench' | 'reading';
  className?: string;
}) {
  const variantClasses = {
    browse: {
      container: 'mb-6 gap-4',
      title: 'text-2xl sm:text-[30px] sm:leading-tight',
      description: 'max-w-2xl text-sm leading-7',
    },
    workbench: {
      container: 'mb-7 gap-3 sm:gap-5',
      title: 'text-[26px] leading-tight sm:text-[32px]',
      description: 'max-w-3xl text-[13px] leading-6 sm:text-sm sm:leading-7',
    },
    reading: {
      container: 'mb-5 gap-3',
      title: 'text-xl leading-tight sm:text-2xl',
      description: 'max-w-2xl text-xs leading-6 sm:text-sm sm:leading-6',
    },
  }[variant];

  return (
    <div
      data-page-header={variant}
      className={cn(
        'flex flex-col sm:flex-row sm:items-start sm:justify-between',
        variantClasses.container,
        className,
      )}
    >
      <div className="min-w-0 space-y-1.5">
        <h1 className={cn('font-semibold tracking-normal', variantClasses.title)}>{title}</h1>
        {description ? (
          <p className={cn('text-muted-foreground', variantClasses.description)}>{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
