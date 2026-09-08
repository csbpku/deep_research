import { LoadingState } from '@/components/StateMessage';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-shell space-y-4" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-56 max-w-full" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <LoadingState label="正在加载专题、热点议题和时间线…" />
      <div className="overflow-hidden rounded-md border border-border bg-card">
        <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-11 rounded-none bg-card" />
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((item) => (
          <div key={item} className="space-y-3 rounded-md border border-border bg-card p-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-20 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
