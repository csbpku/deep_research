import { toRadarSourceCategory } from './source-labels';

export const HIGHLIGHT_POOL_SIZE = 100;
export const HIGHLIGHT_LIMIT = 10;

type HighlightCandidate = {
  id: string;
  sourceType: string | null;
  sourceName: string | null;
  url: string;
};

function categoryFor(item: HighlightCandidate): string {
  if (item.sourceType === 'hn_algolia') return 'community';
  if (item.sourceType === 'openreview') return 'research';
  return toRadarSourceCategory(item.sourceType, item.sourceName) ?? 'other';
}

function sourceFor(item: HighlightCandidate): string {
  const name = item.sourceName?.trim().toLowerCase();
  if (name) return `${item.sourceType ?? ''}:${name}`;
  try {
    return `host:${new URL(item.url).hostname.toLowerCase()}`;
  } catch {
    return `type:${item.sourceType ?? 'unknown'}`;
  }
}

/**
 * Pick from one already-filtered, score-ordered response. A round per category
 * gives smaller groups a chance; within each group prefer a less-used source,
 * then the original server rank. Limits are soft: an available item is never
 * discarded merely because there are no other sources or categories.
 */
export function selectRadarHighlights<T extends HighlightCandidate>(items: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  const seen = new Set<string>();
  for (const item of items.slice(0, HIGHLIGHT_POOL_SIZE)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const category = categoryFor(item);
    const group = groups.get(category) ?? [];
    group.push(item);
    groups.set(category, group);
  }

  const selected: T[] = [];
  const sourceCounts = new Map<string, number>();
  while (selected.length < HIGHLIGHT_LIMIT) {
    let added = false;
    for (const group of groups.values()) {
      if (group.length === 0) continue;
      let best = 0;
      for (let index = 1; index < group.length; index++) {
        const candidateCount = sourceCounts.get(sourceFor(group[index])) ?? 0;
        const bestCount = sourceCounts.get(sourceFor(group[best])) ?? 0;
        if (candidateCount < bestCount) best = index;
      }
      const [item] = group.splice(best, 1);
      selected.push(item);
      const source = sourceFor(item);
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
      added = true;
      if (selected.length === HIGHLIGHT_LIMIT) break;
    }
    if (!added) break;
  }
  return selected;
}
