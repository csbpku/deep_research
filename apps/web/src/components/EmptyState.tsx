import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * EmptyState —— 空状态占位。全站 7+ 处使用。
 * 虚线描边 + 居中，与实心卡片区分开，一眼看出「这里本来该有内容」。
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center rounded-md border border-dashed border-border bg-card px-6 py-10 text-center',
        className,
      )}
    >
      <h2 className="text-base font-semibold tracking-normal">{title}</h2>
      {description ? (
        <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
