import * as React from 'react';
import { AlertTriangle, LoaderCircle, type LucideIcon } from 'lucide-react';
import styles from './state.module.css';

export function LoadingState({ label = '正在加载', className }: { label?: React.ReactNode; className?: string }) {
  return <div role="status" aria-live="polite" className={[styles.state, styles.loading, className].filter(Boolean).join(' ')}><LoaderCircle aria-hidden /><span>{label}</span></div>;
}

export function ErrorState({ title = '加载失败', description, action, icon: Icon = AlertTriangle, className }: {
  title?: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; icon?: LucideIcon; className?: string;
}) {
  return <div role="alert" data-tone="danger" className={[styles.state, styles.error, className].filter(Boolean).join(' ')}>
    <Icon aria-hidden />
    <div className={styles.errorBody}>
      <p className={styles.errorTitle}>{title}</p>
      {description ? <div className={styles.description}>{description}</div> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  </div>;
}
