import { Skeleton } from '../../../components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--ink-page)]" role="status" aria-label="正在加载雷达详情">
      <span className="sr-only">正在加载雷达详情</span>
      <div className="flex min-h-14 items-center justify-between border-b border-[var(--ink-rule)] px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-16" />
          <Skeleton className="h-10 w-24" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-10 lg:py-14">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-14">
          <div>
            <div className="flex gap-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="mt-5 h-14 w-full max-w-4xl" />
            <Skeleton className="mt-7 h-28 w-full max-w-4xl" />
            <div className="mt-6 flex gap-2">
              <Skeleton className="h-7 w-24" />
              <Skeleton className="h-7 w-32" />
              <Skeleton className="h-7 w-20" />
            </div>
          </div>
          <div className="border-y border-[var(--ink-rule)] py-5 lg:border-y-0 lg:border-l lg:pl-6">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-3 w-36" />
            <Skeleton className="mt-6 h-9 w-20" />
            <Skeleton className="mt-5 h-12 w-full" />
          </div>
        </div>
        <div className="mt-12 border-y border-[var(--ink-rule)] py-8">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-3 h-6 w-72 max-w-full" />
          <Skeleton className="mt-5 h-16 w-full max-w-3xl" />
        </div>
      </div>
    </div>
  );
}
