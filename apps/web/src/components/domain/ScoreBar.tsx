import * as React from 'react';

import Box, { type BoxProps } from '@mui/material/Box';

/**
 * Distilled score 的 tier 视觉映射 —— 单一事实来源。
 * 当前等级为 deep_read / skim / noise；collection 只兼容历史数据。
 */
export const TIER_LABELS: Record<string, string> = {
  deep_read: '精读',
  skim: '速读',
  collection: '精读',
  noise: '不推荐',
};

/** MUI consumers use domain colors directly, without Tailwind presentation. */
export function readingTierColor(tier: string | null | undefined): string {
  const key = tier === 'collection' ? 'deep_read' : tier;
  const token = key === 'deep_read' ? '--dr-color-tier-deep-read'
    : key === 'skim' ? '--dr-color-tier-skim'
      : key === 'noise' ? '--dr-color-tier-noise' : null;
  return token ? `var(${token})` : 'var(--dr-color-text-secondary)';
}

function scoreTierColor(tier: string): string {
  const normalizedTier = tier === 'collection' ? 'deep_read' : tier;
  const token = normalizedTier === 'skim' ? '--dr-color-tier-skim'
    : normalizedTier === 'noise' ? '--dr-color-tier-noise'
      : '--dr-color-tier-deep-read';
  return `var(${token})`;
}

/**
 * ScoreBar —— 单个维度的 0–3 分段条。
 * 迁移前 DistilledScorePanel 与 RadarCandidateCard 各写一遍内联 div。
 */
export function ScoreBar({
  label,
  value,
  max = 3,
  tier = 'deep_read',
  className,
  sx,
}: {
  label: string;
  value: number;
  max?: number;
  tier?: string;
  className?: string;
  sx?: BoxProps<'div'>['sx'];
}) {
  const tierColor = scoreTierColor(tier);
  const segments = Array.from({ length: max + 1 }, (_, i) => i);

  return (
    <Box
      className={className}
      sx={[
        { display: 'flex', flexDirection: 'column', gap: 'var(--dr-space-1)' },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      <Box component="div" sx={{ color: 'text.secondary', typography: 'metadata' }}>{label}</Box>
      <Box
        component="div"
        sx={{ display: 'flex', gap: '2px' }}
        role="meter"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        {segments.map((i) => (
          <Box
            component="span"
            key={i}
            sx={{
              width: 16,
              height: 4,
              borderRadius: '2px',
              bgcolor: i <= value ? tierColor : 'var(--dr-color-tier-track)',
            }}
          />
        ))}
      </Box>
    </Box>
  );
}

/**
 * ScoreDial —— tier 总分圆环。compact 用于列表卡片，默认用于详情页。
 */
export function ScoreDial({
  total,
  tier,
  size = 'default',
  sx,
}: {
  total: number;
  tier: string;
  size?: 'default' | 'compact';
  sx?: BoxProps<'div'>['sx'];
}) {
  const tierColor = scoreTierColor(tier);
  const dimension = size === 'compact' ? 32 : 48;
  return (
    <Box
      component="div"
      sx={[
        {
          display: 'flex',
          width: dimension,
          height: dimension,
          flexShrink: 0,
          alignItems: 'center',
          justifyContent: 'center',
          border: `${size === 'compact' ? 2 : 3}px solid ${tierColor}`,
          borderRadius: '50%',
          color: tierColor,
          fontFamily: 'monospace',
          fontWeight: 'var(--dr-weight-bold)',
          fontVariantNumeric: 'tabular-nums',
          fontSize: size === 'compact' ? 'var(--dr-type-caption)' : 'var(--dr-type-title-small)',
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {total}
    </Box>
  );
}
