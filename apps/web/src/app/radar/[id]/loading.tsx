import { Skeleton } from '../../../components/ui/skeleton';

export default function Loading() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      role="status"
      aria-label="正在加载雷达详情"
    >
      <span className="sr-only">正在加载雷达详情</span>
      <div className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-7 w-24" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-[var(--ink-page)] px-4 py-6 sm:px-8 sm:py-8">
        <div className="mx-auto w-full max-w-5xl">
          <div className="mb-4 flex gap-3">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-10 w-4/5 max-w-3xl" />
          <Skeleton className="mt-5 h-24 w-full max-w-4xl" />
          <div className="mt-8 space-y-4">
            <Skeleton className="h-4 w-full max-w-3xl" />
            <Skeleton className="h-4 w-11/12 max-w-3xl" />
            <Skeleton className="h-4 w-4/5 max-w-3xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
