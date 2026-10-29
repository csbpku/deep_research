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
