import { cn } from '@/lib/utils';

/** 加载骨架屏 —— 替代「加载中…」纯文字，减少布局跳动。
 *  motion-safe:animate-pulse 让 prefers-reduced-motion 用户看到静态骨架而非闪烁 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('motion-safe:animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)}
      aria-hidden
      {...props}
    />
  );
}

export { Skeleton };
