import { Waypoints } from 'lucide-react';

import { cn } from '@/lib/utils';

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-md border border-primary/25 bg-primary/10 text-primary',
        className,
      )}
      aria-hidden
    >
      <Waypoints className="size-4" strokeWidth={2.2} />
    </span>
  );
}
