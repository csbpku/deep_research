import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Distilled score 的 tier 视觉映射 —— 单一事实来源。
 * tier 枚举来自 packages/ai-engine/ai_engine/scoring（deep_read / skim / collection / noise）。
 */
export const TIER_LABELS: Record<string, string> = {
  deep_read: '深读',
  skim: '速览',
  collection: '重点阅读',
  noise: '不推荐',
};

/** tier → 文字色 / 描边色 / 填充色 三件套（token 化，深浅色自动切换） */
export const TIER_CLASSES: Record<string, { text: string; border: string; fill: string }> = {
  deep_read: {
    text: 'text-tier-deep-read',
    border: 'border-tier-deep-read',
    fill: 'bg-tier-deep-read',
  },
  skim: { text: 'text-tier-skim', border: 'border-tier-skim', fill: 'bg-tier-skim' },
  collection: {
    text: 'text-tier-collection',
    border: 'border-tier-collection',
    fill: 'bg-tier-collection',
  },
  noise: { text: 'text-tier-noise', border: 'border-tier-noise', fill: 'bg-tier-noise' },
};

export function tierClasses(tier: string) {
  return TIER_CLASSES[tier] ?? TIER_CLASSES.collection;
}

/**
 * ScoreBar —— 单个维度的 0–3 分段条。
 * 迁移前 DistilledScorePanel 与 RadarCandidateCard 各写一遍内联 div。
 */
export function ScoreBar({
  label,
  value,
  max = 3,
  tier = 'collection',
  className,
}: {
  label: string;
  value: number;
  max?: number;
  tier?: string;
  className?: string;
}) {
  const { fill } = tierClasses(tier);
  const segments = Array.from({ length: max + 1 }, (_, i) => i);

  return (
    <div className={cn('space-y-1', className)}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className="flex gap-0.5"
        role="meter"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        {segments.map((i) => (
          <span
            key={i}
            className={cn('h-1 w-4 rounded-sm', i <= value ? fill : 'bg-tier-track')}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * ScoreDial —— tier 总分圆环。compact 用于列表卡片，默认用于详情页。
 */
export function ScoreDial({
  total,
  tier,
  size = 'default',
}: {
  total: number;
  tier: string;
  size?: 'default' | 'compact';
}) {
  const { text, border } = tierClasses(tier);
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-mono font-bold tabular-nums',
        border,
        text,
        size === 'compact' ? 'size-8 border-2 text-xs' : 'size-12 border-[3px] text-lg',
      )}
    >
      {total}
    </div>
  );
}
