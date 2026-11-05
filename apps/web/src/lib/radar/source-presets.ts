/** Explicit operator-selected sources; none are installed by startup. */
export const RADAR_SOURCE_PRESETS = [
  {
    id: 'simon-willison-entries', name: 'Simon Willison 的博客',
    description: '作者的长篇文章，覆盖 AI 工具与软件工程。',
    feedUrl: 'https://simonwillison.net/atom/entries/', maxResults: 15, maxAgeHours: 168,
    applyAiFilter: true,
  },
  {
    id: 'nvidia-developer-blog', name: 'NVIDIA Developer Blog',
    description: '开发者博客，覆盖 AI、GPU 和系统工程。',
    feedUrl: 'https://developer.nvidia.com/blog/feed/', maxResults: 15, maxAgeHours: 168,
    applyAiFilter: true,
  },
] as const;

export type SourcePreset = typeof RADAR_SOURCE_PRESETS[number];
export type ExistingSource = { id: string; name: string; enabled: boolean; autoPausedAt: Date | null; config: unknown };

/** Compare common URL spelling variants without fetching or discarding meaningful query parameters. */
export function feedIdentity(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    const port = url.port && !['80', '443'].includes(url.port) ? `:${url.port}` : '';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    url.searchParams.sort();
    return `${host}${port}${path}${url.search}`;
  } catch { return null; }
}

export function matchingSources(preset: SourcePreset, rows: ExistingSource[]): ExistingSource[] {
  const identity = feedIdentity(preset.feedUrl);
  return rows.filter((row) => {
    if (!row.config || typeof row.config !== 'object' || Array.isArray(row.config)) return false;
    const feed = (row.config as Record<string, unknown>).feedUrl;
    return typeof feed === 'string' && identity !== null && feedIdentity(feed) === identity;
  });
}
