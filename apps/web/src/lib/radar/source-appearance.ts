import { isHackerNewsSourceName, toRadarSourceCategory, type RadarSourceCategory } from './source-labels';

const categories: readonly string[] = ['github', 'articles', 'community', 'research', 'shared'];

/** Source identity only. Never derive a source color from score, lifecycle or URL. */
export function radarSourceAppearance(sourceType: string | null | undefined, sourceName?: string | null) {
  const category = isHackerNewsSourceName(sourceName)
    ? 'community'
    : categories.includes(sourceType ?? '')
      ? sourceType as RadarSourceCategory
      : toRadarSourceCategory(sourceType, sourceName);
  return {
    category: category ?? 'other',
    color: category ? `var(--dr-color-source-${category})` : 'var(--dr-color-text-secondary)',
    background: category ? `var(--dr-color-source-${category}-container)` : 'var(--dr-color-surface-container)',
  };
}
