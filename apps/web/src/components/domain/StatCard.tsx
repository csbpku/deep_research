import * as React from 'react';

import Paper from '@mui/material/Paper';
import styles from './domain.module.css';

/**
 * StatCard —— 指标数字块。
 * 迁移前 AdminConsole 顶部指标区、ai-research/[jobId] 的百分比/成本/耗时各写一遍。
 *
 * Shared 12px labels and 20px values; tabular numerals avoid layout jitter.
 */
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  className,
  variant = 'outlined',
  density = 'normal',
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'default' | 'primary' | 'muted';
  className?: string;
  variant?: 'outlined' | 'grid';
  density?: 'normal' | 'compact' | 'dense';
}) {
  return (
    <Paper component="div" variant="outlined" data-stat-tone={tone} data-stat-variant={variant} data-stat-density={density}
      className={[styles.statCard, 'material-surface', className].filter(Boolean).join(' ')}>
      <div className={styles.statLabel}>
        {label}
      </div>
      <div
        className={styles.statValue}
      >
        {value}
      </div>
      {hint ? <div className={styles.statHint}>{hint}</div> : null}
    </Paper>
  );
}
