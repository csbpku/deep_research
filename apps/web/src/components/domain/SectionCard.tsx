import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * SectionCard —— 详情页的分节容器。
 *
 * 五种 tone：
 *   default  — 常规章节
 *   muted    — 弱化背景（挂载资料等辅助内容）
 *   accent   — 强调（AI 解读、左侧色条）
 *   info     — 信息性（适合「背景」「为什么选入」）
 *   success  — 积极（适合「结论」「适合谁读」）
 *   warning  — 提示（适合「风险」「降级生成」）
 *   destructive — 警示
 *
 * UI 重设计第二轮：
 *   1. 6 种 tone，对齐 mockup 三色卡（背景/结论/风险）；
 *   2. icon prop 强制每张彩色卡有图形 —— 满足 a11y 规则 #1（不要只靠颜色）。
 */
export function SectionCard({
  title,
  actions,
  children,
  className,
  bodyClassName,
  tone = 'default',
  icon,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  tone?: 'default' | 'muted' | 'accent' | 'info' | 'success' | 'warning' | 'destructive';
  /** 强制有图标（a11y）：彩色 tone 必须传；default/muted/accent 可选 */
  icon?: LucideIcon;
}) {
  const ToneIcon = icon ?? TONE_DEFAULT_ICON[tone];
  return (
    <section
      className={cn(
        'rounded-md border',
        tone === 'default' && 'border-border bg-card',
        tone === 'muted' && 'border-border bg-muted/40',
        tone === 'accent' && 'border-l-2 border-l-primary border-border bg-accent/40',
        tone === 'info' && 'border-l-2 border-l-status-running-fg/60 border-border bg-status-running-bg/60',
        tone === 'success' && 'border-l-2 border-l-status-succeeded-fg/60 border-border bg-status-succeeded-bg/60',
        tone === 'warning' && 'border-l-2 border-l-status-partial-fg/60 border-border bg-status-partial-bg/60',
        tone === 'destructive' && 'border-l-2 border-l-status-failed-fg/60 border-border bg-status-failed-bg/60',
        className,
      )}
    >
      {title || actions ? (
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground">
            {ToneIcon && (
              <ToneIcon
                aria-hidden
                className={cn(
                  'size-3.5 shrink-0',
                  tone === 'info' && 'text-status-running-fg',
                  tone === 'success' && 'text-status-succeeded-fg',
                  tone === 'warning' && 'text-status-partial-fg',
                  tone === 'destructive' && 'text-status-failed-fg',
                )}
              />
            )}
            {title}
          </h2>
          {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** 没传 icon 时按 tone 兜底一个 —— 彩色 tone 永不裸用纯色。 */
const TONE_DEFAULT_ICON: Partial<Record<'default' | 'muted' | 'accent' | 'info' | 'success' | 'warning' | 'destructive', LucideIcon>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  destructive: AlertTriangle,
  accent: Info,
};
