import * as React from 'react';
import { AlertTriangle, Inbox, Info, type LucideIcon } from 'lucide-react';
import styles from './state.module.css';

export function EmptyState({ title, description, action, className, tone = 'neutral', icon, compact = false }: {
  title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string;
  tone?: 'neutral' | 'info' | 'danger'; icon?: LucideIcon; compact?: boolean;
}) {
  const StateIcon = icon ?? (tone === 'danger' ? AlertTriangle : tone === 'info' ? Info : Inbox);
  return <div role={tone === 'danger' ? 'alert' : undefined} data-tone={tone} data-compact={compact} className={[styles.state, styles.empty, className].filter(Boolean).join(' ')}>
    <div className={styles.icon} aria-hidden><StateIcon /></div>
    <h2>{title}</h2>
    {description ? <div className={styles.description}>{description}</div> : null}
    {action ? <div className={styles.action}>{action}</div> : null}
  </div>;
}
