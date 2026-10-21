import * as React from 'react';
import styles from './domain.module.css';

/** Keep native form submission and Enter behavior; only appearance is shared. */
export function FilterBar({ onSubmit, children, trailing, className, desktopOnly = false }: {
  onSubmit?: React.FormEventHandler<HTMLFormElement>; children: React.ReactNode;
  trailing?: React.ReactNode; className?: string; desktopOnly?: boolean;
}) {
  return <form onSubmit={onSubmit} data-desktop-only={desktopOnly} className={[styles.filterBar, className].filter(Boolean).join(' ')}>
    {children}
    {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
  </form>;
}
