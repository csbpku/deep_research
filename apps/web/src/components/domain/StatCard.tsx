import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * StatCard —— 指标数字块。
 * 迁移前 AdminConsole 顶部指标区、ai-research/[jobId] 的百分比/成本/耗时各写一遍。
 *
 * Data-Dense：标签 11px 大写、数值等宽 tabular-nums，避免跳数时抖动。
 */
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'default' | 'primary' | 'muted';
  className?: string;
}) {
  return (
    <div className={cn('rounded-lg border border-border bg-card p-3', className)}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 font-mono text-xl font-semibold tabular-nums leading-tight',
          tone === 'primary' && 'text-primary',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
