export const ZREAD_SAMPLE_URL = 'https://github.com/deepseek-ai/deepseek-harness';

const GITHUB_ISSUE_RE = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+(?:\/|$)/iu;
const GITHUB_PULL_RE = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/iu;
const GITHUB_RELEASE_RE = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/releases\/tag\//iu;
const GITHUB_REPO_RE = /^https?:\/\/github\.com\/[^/]+\/[^/?#]+(?:\.git)?\/?$/iu;

/**
 * The effective content shape of a radar item.
 *
 * ``originalKind`` is the authoritative label, but rows ingested before the
 * platform switched to external reading can carry a null kind even though
 * the URL identifies the shape unambiguously.  Falling back to the URL keeps
 * repository-only entry points (Zread) and the repository/web-page label
 * working for historical rows instead of silently degrading them.
 */
export function effectiveOriginalKind(
  originalKind: string | null | undefined,
  url: string | null | undefined,
): string | null {
  if (originalKind) return originalKind;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname;
    if (host === 'github.com' || host === 'www.github.com') {
      if (GITHUB_ISSUE_RE.test(url)) return 'github_issue';
      if (GITHUB_PULL_RE.test(url)) return 'github_pr';
      if (GITHUB_RELEASE_RE.test(url)) return 'github_release';
      if (GITHUB_REPO_RE.test(url)) return 'github_repo';
      return 'github_other';
    }
    if (host === 'arxiv.org' || host === 'huggingface.co') return 'arxiv';
  } catch {
    return null;
  }
  return null;
}

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
