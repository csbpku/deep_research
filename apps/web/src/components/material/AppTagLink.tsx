'use client';

import React, { type ReactElement } from 'react';
import Link from 'next/link';
import Chip from '@mui/material/Chip';
import { space } from '@deep-research/design-system';

/** Explicit icon/label geometry keeps wrapped text aligned without MUI's icon-slot margins. */
export function AppTagLink({ href, label, icon, tone = 'neutral', title }: {
  href: string;
  label: string;
  icon?: ReactElement;
  tone?: 'neutral' | 'info' | 'error';
  title?: string;
}) {
  const chipLabel = icon ? (
    <span data-app-tag-content="with-icon">
      <span data-app-tag-icon="true" aria-hidden="true">{icon}</span>
      <span data-app-tag-text="true">{label}</span>
    </span>
  ) : label;

  return (
    <Chip component={Link} clickable variant="outlined" size="small"
      href={href} label={chipLabel} title={title ?? label}
      sx={{
        display: 'inline-flex', alignItems: 'center',
        padding: `${space.xs} ${space.sm}`,
        minWidth: 0, maxWidth: '100%', minHeight: '28px', height: 'auto',
        color: tone === 'neutral' ? 'text.secondary' : tone === 'info' ? 'info.main' : 'error.main',
        '& .MuiChip-label': {
          display: 'block', padding: 0, minWidth: 0, lineHeight: 'var(--dr-line-height-control)',
          whiteSpace: 'normal', overflowWrap: 'anywhere',
        },
        '& [data-app-tag-content="with-icon"]': {
          display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr)',
          alignItems: 'start', columnGap: space.xs, minWidth: 0,
        },
        '& [data-app-tag-icon]': {
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '14px', height: '1.5em', flexShrink: 0, color: 'inherit',
        },
        '& [data-app-tag-icon] svg': { display: 'block', width: '14px', height: '14px', flexShrink: 0 },
        '& [data-app-tag-text]': { minWidth: 0, overflowWrap: 'anywhere' },
        '@media (pointer: coarse)': { minHeight: 'var(--dr-touch-target)' },
      }}
    />
  );
}
