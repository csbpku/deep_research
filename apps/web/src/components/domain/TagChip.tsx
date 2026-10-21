import * as React from 'react';
import Link from 'next/link';
import Chip from '@mui/material/Chip';

import styles from './domain.module.css';

/**
 * TagChip —— 标签胶囊。
 * 迁移前 RadarCandidateCard / researches/page / researches/[id]/page 各写一遍。
 * 传 href 时渲染成可点链接（用于按标签筛选）。
 */
export function TagChip({
  children,
  href,
  className,
}: {
  children: React.ReactNode;
  href?: string;
  className?: string;
}) {
  const base = [styles.tagChip, className].filter(Boolean).join(' ');
  if (href) {
    return (
      <Link href={href} className={styles.tagLink}>
        <Chip component="span" className={base} size="small" label={children} />
      </Link>
    );
  }
  return <Chip component="span" className={base} size="small" label={children} />;
}

/** 标签组容器：自动换行 + 一致间距。 */
export function TagList({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={[styles.tagList, className].filter(Boolean).join(' ')} {...props}>
      {children}
    </div>
  );
}
