'use client';

import React from 'react';
import Chip from '@mui/material/Chip';
import { space } from '@deep-research/design-system';
import { formatSourceType, isHackerNewsSourceName } from '@/lib/radar/source-labels';
import { radarSourceAppearance } from '@/lib/radar/source-appearance';

/** Quiet source identity, shared by list and preview; quality remains a separate label. */
export function RadarSourceChip({ sourceType, sourceName, label }: {
  sourceType: string | null | undefined;
  sourceName?: string | null;
  label?: string;
}) {
  const source = formatSourceType(isHackerNewsSourceName(sourceName) ? 'hackernews' : sourceType);
  const appearance = radarSourceAppearance(sourceType, sourceName);
  return <Chip size="small" label={label ?? source.short} icon={<span aria-hidden="true" />}
    data-radar-source={appearance.category} aria-label={source.full} title={sourceName || source.full}
    sx={{
      color: appearance.color, bgcolor: appearance.background,
      border: '1px solid currentColor', maxWidth: '100%',
      '& .MuiChip-icon': {
        display: 'block', flexShrink: 0, width: '8px', height: '8px',
        margin: `0 0 0 ${space.sm}`, borderRadius: '50%', color: 'inherit', backgroundColor: 'currentColor',
      },
      '& .MuiChip-label': { paddingLeft: space.xs, paddingRight: space.sm },
    }} />;
}
