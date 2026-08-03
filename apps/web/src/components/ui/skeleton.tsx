import { cn } from '@/lib/utils';

/** 加载骨架屏 —— 替代「加载中…」纯文字，减少布局跳动。 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export { Skeleton };
