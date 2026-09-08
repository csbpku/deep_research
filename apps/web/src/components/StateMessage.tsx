import {
  AlertTriangle,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * 小区域的异步状态。页面级状态使用 EmptyState，
 * 列表分组、侧栏和面板使用这里的紧凑表达，避免只丢一行“加载失败”。
 */
export function LoadingState({
  label = '正在加载',
  className,
}: {
  label?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center gap-2 rounded-md border border-border bg-muted/25 px-3 py-3 text-xs text-muted-foreground',
        className,
      )}
    >
      <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({
  title = '加载失败',
  description,
  action,
  icon: Icon = AlertTriangle,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-md border border-destructive/35 bg-destructive/5 px-3 py-3 text-sm',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium text-destructive">{title}</p>
          {description ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
          ) : null}
          {action ? <div className="mt-2">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}
