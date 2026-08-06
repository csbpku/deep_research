import { Skeleton } from '@/components/ui/skeleton';

/**
 * App Router 导航的即时反馈。
 * 页面数据仍然按各自的 query 加载，但切页时先保留稳定的内容轮廓，
 * 避免用户把 RSC/接口等待误认为点击没有生效。
 */
export default function Loading() {
  return (
    <div className="mx-auto max-w-shell space-y-4" aria-busy="true" aria-label="页面加载中">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-3">
        {[0, 1, 2].map((item) => (
          <div key={item} className="space-y-2 rounded-lg border border-border bg-card p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
