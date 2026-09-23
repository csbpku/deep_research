export const ZREAD_SAMPLE_URL = 'https://github.com/deepseek-ai/deepseek-harness';

/** Return the public Zread document URL for a GitHub repository root. */
export function zreadRepositoryUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'github.com' || parsed.searchParams.has('digest')) {
      return null;
    }
    const [owner, rawRepo, ...rest] = parsed.pathname.split('/').filter(Boolean);
    if (!owner || !rawRepo || rest.length > 0) return null;
    const repo = rawRepo.replace(/\.git$/u, '');
    if (!repo) return null;
    return `https://zread.ai/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  } catch {
    return null;
  }
}

/** Repo reading mode is intentionally limited to GitHub repositories. */
export function isZreadRepository(url: string): boolean {
  return zreadRepositoryUrl(url) !== null;
}
