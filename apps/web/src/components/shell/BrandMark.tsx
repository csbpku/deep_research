import { Waypoints } from 'lucide-react';

import styles from './shell.module.css';

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={[styles.brand, className].filter(Boolean).join(' ')}
      aria-hidden
    >
      <Waypoints strokeWidth={2.2} />
    </span>
  );
}
