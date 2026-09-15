/**
 * A small, deliberately explainable source taxonomy for the reader UI.
 *
 * This is presentation metadata, not a claim that a page is trustworthy by
 * itself. The evidence ledger still requires an excerpt and a separate fact
 * review. The independent key is intentionally the normalized host so pages
 * from one mirror/domain cannot look like independent corroboration.
 */

export type SourceProvenanceKind =
  | 'official_docs'
  | 'standard'
  | 'repository'
  | 'paper'
  | 'vendor'
  | 'community'
  | 'directory'
  | 'web';

export interface SourceProvenance {
  kind: SourceProvenanceKind;
  label: string;
  independentKey: string;
}

const LABELS: Record<SourceProvenanceKind, string> = {
  official_docs: '官方文档',
  standard: '标准/规范',
  repository: '原始仓库',
  paper: '论文/预印本',
  vendor: '厂商资料',
  community: '社区经验',
  directory: '镜像/目录',
  web: '普通网页',
};

const STANDARD_HOSTS = new Set([
  'w3.org',
  'ietf.org',
  'rfc-editor.org',
  'iso.org',
  'ecma-international.org',
  'whatwg.org',
  'tc39.es',
  'unicode.org',
]);

const REPOSITORY_HOSTS = new Set(['github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org', 'sourceforge.net']);
const PAPER_HOSTS = new Set(['doi.org', 'arxiv.org', 'aclanthology.org', 'semanticscholar.org']);
const DIRECTORY_HOSTS = new Set(['zread.ai', 'hub.docker.com', 'npmjs.com', 'www.npmjs.com', 'pypi.org', 'libraries.io']);
const COMMUNITY_HOSTS = new Set([
  'stackoverflow.com',
  'stackexchange.com',
  'reddit.com',
  'news.ycombinator.com',
  'dev.to',
  'medium.com',
  'zhihu.com',
  'juejin.cn',
]);

function normalizeHost(hostname: string): string {
  return hostname.toLocaleLowerCase().replace(/^www\./u, '');
}

function hostMatches(host: string, candidates: Set<string>): boolean {
  return candidates.has(host) || [...candidates].some((candidate) => host.endsWith(`.${candidate}`));
}

function parseUrl(value: string | null | undefined): URL | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

function classifyHost(host: string, pathAndTitle: string, type: string | null | undefined): SourceProvenanceKind {
  const normalizedType = type?.toLocaleLowerCase() ?? '';
  if (normalizedType.includes('official_repository')) return 'repository';
  if (normalizedType.includes('official_document')) return 'official_docs';
  if (normalizedType.includes('standard')) return 'standard';
  if (normalizedType.includes('community')) return 'community';
  if (normalizedType === 'doi' || normalizedType === 'arxiv' || hostMatches(host, PAPER_HOSTS)) return 'paper';
  if (hostMatches(host, STANDARD_HOSTS) || /\b(?:rfc|iso|ecma|w3c|whatwg|tc39)\b|标准|规范/iu.test(pathAndTitle)) return 'standard';
  if (hostMatches(host, REPOSITORY_HOSTS)) return 'repository';
  if (hostMatches(host, DIRECTORY_HOSTS) || /(?:mirror|registry|directory|目录|镜像)/iu.test(pathAndTitle)) return 'directory';
  if (hostMatches(host, COMMUNITY_HOSTS) || /(?:stackoverflow|reddit|forum|community|讨论|社区|博客|blog)/iu.test(pathAndTitle)) return 'community';
  if (/^(?:docs?|developer|developers|dev|reference)\./iu.test(host) || /(?:\/docs?(?:\/|$)|\/reference(?:\/|$)|官方文档|official documentation)/iu.test(pathAndTitle)) return 'official_docs';
  if (/(?:官方|official|vendor|厂商|产品资料)/iu.test(pathAndTitle)) return 'vendor';
  return 'web';
}

export function classifySourceProvenance(input: {
  href?: string | null;
  type?: string | null;
  title?: string | null;
}): SourceProvenance {
  const parsed = parseUrl(input.href);
  const host = parsed ? normalizeHost(parsed.hostname) : '';
  const context = [input.href, input.title].filter(Boolean).join(' ');
  const normalizedType = input.type?.toLocaleLowerCase() ?? '';
  const kind = host
    ? classifyHost(host, context, input.type)
    : normalizedType.includes('official_repository')
      ? 'repository'
      : normalizedType.includes('official_document')
        ? 'official_docs'
        : normalizedType.includes('standard')
          ? 'standard'
          : normalizedType.includes('community')
            ? 'community'
            : 'web';
  return {
    kind,
    label: LABELS[kind],
    independentKey: host || '未解析域名',
  };
}
