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

// A source can only be called "official documentation" when its hostname is
// on a maintained first-party allowlist. A /docs path, a page title, or a
// model-provided `official_document` type is not proof of ownership.
const OFFICIAL_DOC_HOSTS = new Set([
  'ai.google.dev',
  'certbot.eff.org',
  'cloud.google.com',
  'developer.chrome.com',
  'developer.mozilla.org',
  'developers.google.com',
  'developers.openai.com',
  'docs.anthropic.com',
  'docs.aws.amazon.com',
  'docs.docker.com',
  'docs.gitlab.com',
  'docs.github.com',
  'docs.python.org',
  'duckdb.org',
  'kubernetes.io',
  'learn.microsoft.com',
  'nextjs.org',
  'nginx.org',
  'nodejs.org',
  'openai.com',
  'platform.openai.com',
  'postgresql.org',
  'react.dev',
  'sqlite.org',
  'vercel.com',
]);

const REPOSITORY_HOSTS = new Set(['github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org', 'sourceforge.net']);
const PAPER_HOSTS = new Set(['doi.org', 'arxiv.org', 'aclanthology.org', 'semanticscholar.org']);
const DIRECTORY_HOSTS = new Set([
  'aardio.com',
  'coddy.tech',
  'hub.docker.com',
  'libraries.io',
  'npmjs.com',
  'pypi.org',
  'readthedocs.io',
  'runebook.dev',
  'typeerror.org',
  'w3cub.com',
  'zread.ai',
]);
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
  if (hostMatches(host, STANDARD_HOSTS) || /\b(?:rfc|iso|ecma|w3c|whatwg|tc39)\b|标准|规范/iu.test(pathAndTitle)) return 'standard';
  if (hostMatches(host, REPOSITORY_HOSTS)) return 'repository';
  if (normalizedType === 'doi' || normalizedType === 'arxiv' || hostMatches(host, PAPER_HOSTS)) return 'paper';
  if (hostMatches(host, DIRECTORY_HOSTS) || /(?:mirror|registry|directory|目录|镜像)/iu.test(pathAndTitle)) return 'directory';
  if (hostMatches(host, COMMUNITY_HOSTS) || /(?:stackoverflow|reddit|forum|community|讨论|社区|博客|blog)/iu.test(pathAndTitle)) return 'community';
  if (hostMatches(host, OFFICIAL_DOC_HOSTS)) return 'official_docs';
  // The type field is advisory metadata from a retriever/model. It may
  // upgrade a known first-party hostname, but it must never override the
  // domain checks above and turn an arbitrary mirror into official material.
  if (normalizedType.includes('official_repository')) return 'web';
  if (normalizedType.includes('official_document')) return 'web';
  if (normalizedType.includes('standard')) return 'web';
  if (normalizedType.includes('community')) return 'community';
  if (/(?:vendor|厂商|产品资料)/iu.test(normalizedType) || /(?:vendor|厂商|产品资料)/iu.test(pathAndTitle)) return 'vendor';
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
      ? 'web'
      : normalizedType.includes('official_document')
        ? 'web'
        : normalizedType.includes('standard')
          ? 'web'
          : normalizedType.includes('community')
            ? 'community'
            : 'web';
  return {
    kind,
    label: LABELS[kind],
    independentKey: host || '未解析域名',
  };
}
