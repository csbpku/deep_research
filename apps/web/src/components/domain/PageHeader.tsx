import * as React from 'react';
import styles from './domain.module.css';

/** Layout may vary by task, but heading levels always use the shared scale. */
export function PageHeader({ title, description, actions, variant = 'browse', className }: {
  title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode;
  variant?: 'browse' | 'workbench' | 'reading'; className?: string;
}) {
  return <header data-page-header={variant} className={[styles.header, className].filter(Boolean).join(' ')}>
    <div className={styles.heading}>
      <h1>{title}</h1>
      {description ? <p className={styles.description}>{description}</p> : null}
    </div>
    {actions ? <div className={styles.actions}>{actions}</div> : null}
  </header>;
}
