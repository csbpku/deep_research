import { isHttpUrl } from './external-url';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ResearchSourceLink {
  href: string;
  external: boolean;
}

export function resolveResearchSourceLink(
  ref: { type?: string; value?: string },
  canonicalKey?: string,
): ResearchSourceLink | null {
  const type = ref.type?.trim().toLowerCase();
  const value = ref.value?.trim();

  if (type === 'url' && value && isHttpUrl(value)) {
    return { href: value, external: true };
  }
  if (type === 'doi' && value) {
    const href = isHttpUrl(value)
      ? value
      : `https://doi.org/${value.replace(/^doi:\s*/iu, '')}`;
    return isHttpUrl(href) ? { href, external: true } : null;
  }
  if (type === 'arxiv' && value) {
    const href = isHttpUrl(value)
      ? value
      : `https://arxiv.org/abs/${value.replace(/^arxiv:\s*/iu, '')}`;
    return isHttpUrl(href) ? { href, external: true } : null;
  }
  if (type === 'summary' && value && UUID_RE.test(value)) {
    return { href: `/radar/${value}`, external: false };
  }
  if (type === 'research' && value && UUID_RE.test(value)) {
    return { href: `/researches/${value}`, external: false };
  }
  if (canonicalKey && isHttpUrl(canonicalKey)) {
    return { href: canonicalKey, external: true };
  }
  return null;
}
