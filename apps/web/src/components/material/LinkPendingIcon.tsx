'use client';

import React, { type ReactNode } from 'react';
import { useLinkStatus } from 'next/link';
import CircularProgress from '@mui/material/CircularProgress';

import styles from './link-pending.module.css';

/** Inside a Next Link: keep its icon slot stable while the router owns pending state. */
export function LinkPendingIcon({ children, label }: { children: ReactNode; label: string }) {
  const { pending } = useLinkStatus();
  return (
    <span className={styles.slot}>
      {pending ? (
        <span className={styles.pending} role="status" aria-label={`正在加载${label}`}>
          <CircularProgress size={16} color="inherit" aria-hidden />
          <span className={styles.srOnly}>{`正在加载${label}`}</span>
        </span>
      ) : children}
    </span>
  );
}
