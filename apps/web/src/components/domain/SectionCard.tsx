import * as React from 'react';
import Paper from '@mui/material/Paper';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  type LucideIcon,
} from 'lucide-react';

import { domainAppearance, type DomainPalette } from './appearance';
import styles from './domain.module.css';

/**
 * SectionCard —— 详情页的分节容器。
 *
 * Seven tones; all appearance is derived from the shared palette.
 *   default  — 常规章节
 *   muted    — 弱化背景（挂载资料等辅助内容）
 *   accent   — 强调（AI 解读、左侧色条）
 *   info     — 信息性（适合「背景」「为什么选入」）
 *   success  — 积极（适合「结论」「适合谁读」）
 *   warning  — 提示（适合「风险」「降级生成」）
 *   destructive — 警示
 *
 * Keep this wrapper server-compatible: Lucide component functions are rendered
 * here, never serialized as props across the Paper client boundary.
 */
export function SectionCard({
  title,
  actions,
  children,
  className,
  bodyClassName,
  bodySpacing = 'normal',
  variant = 'outlined',
  tone = 'default',
  icon,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  bodySpacing?: 'normal' | 'none' | 'top';
  variant?: 'outlined' | 'reading';
  tone?: 'default' | 'muted' | 'accent' | 'info' | 'success' | 'warning' | 'destructive';
  /** 强制有图标（a11y）：彩色 tone 必须传；default/muted/accent 可选 */
  icon?: LucideIcon;
}) {
  const ToneIcon = icon ?? TONE_DEFAULT_ICON[tone];
  const appearance = domainAppearance(TONE_PALETTE[tone]);
  return (
    <Paper component="section" variant="outlined"
      data-section-tone={tone} data-section-variant={variant}
      className={[styles.sectionCard, 'material-surface', className].filter(Boolean).join(' ')}
      style={{ '--section-accent': appearance.color, '--section-background': appearance.backgroundColor } as React.CSSProperties}
    >
      {title || actions ? (
        <header className={styles.sectionHeader}>
          {title ? <h2 className={styles.sectionTitle}>
            {ToneIcon && (
              <ToneIcon aria-hidden />
            )}
            {title}
          </h2> : null}
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      ) : null}
      <div data-body-spacing={bodySpacing} className={[styles.sectionBody, bodyClassName].filter(Boolean).join(' ')}>{children}</div>
    </Paper>
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

const TONE_PALETTE: Record<'default' | 'muted' | 'accent' | 'info' | 'success' | 'warning' | 'destructive', DomainPalette> = {
  default: 'neutral', muted: 'neutral', accent: 'evidence', info: 'evidence',
  success: 'success', warning: 'warning', destructive: 'danger',
};
