import {
  AlertTriangle,
  Inbox,
  Info,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * EmptyState —— 空状态占位。
 * 中性空状态保持轻量；错误/受限状态用语义色和图标明确说明，不只靠颜色。
 */
export function EmptyState({
  title,
  description,
  action,
  className,
  tone = 'neutral',
  icon,
  compact = false,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  tone?: 'neutral' | 'info' | 'danger';
  icon?: LucideIcon;
  compact?: boolean;
}) {
  const StateIcon = icon ?? (
    tone === 'danger' ? AlertTriangle : tone === 'info' ? Info : Inbox
  );

  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cn(
        'flex flex-col items-center rounded-md border text-center',
        compact ? 'px-4 py-6' : 'px-6 py-10',
        tone === 'neutral' && 'border-dashed border-border bg-card/70',
        tone === 'info' && 'border-primary/25 bg-primary/5',
        tone === 'danger' && 'border-destructive/35 bg-destructive/5',
        className,
      )}
    >
      <div
        className={cn(
          'mb-3 grid size-9 place-items-center rounded-full border',
          tone === 'neutral' && 'border-border bg-muted text-muted-foreground',
          tone === 'info' && 'border-primary/20 bg-primary/10 text-primary',
          tone === 'danger' && 'border-destructive/20 bg-destructive/10 text-destructive',
        )}
        aria-hidden
      >
        <StateIcon className="size-4" />
      </div>
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
