import { cleanResearchLabel } from './research-markdown-cleanup';

/** A source that is known to have been captured by the current research run. */
export interface ResearchCitationSource {
  title?: string | null;
  href?: string | null;
}

interface CitationToken {
  start: number;
  end: number;
  href: string;
  label?: string;
  /** Image links are reserved so their URL is not mistaken for visible text. */
  replaceable: boolean;
}

interface Citation {
  href: string;
  title: string;
}

interface ReferenceSection {
  start: number;
  end: number;
}

const REFERENCE_HEADING = /^\s{0,3}(#{1,6})\s+(?:参考文献|参考资料|references?|bibliography)\s*#*\s*$/iu;
const FENCE = /^\s*(`{3,}|~{3,})/u;
const TRAILING_URL_PUNCTUATION = /[.,;:!?，。；：！？、]+$/u;

/**
 * Compact reader-facing citations without touching the persisted report.
 *
 * Only HTTP(S) links that also exist in the current source ledger are
 * compacted. This keeps a visually neat `[1]` from becoming an implicit
 * claim that an arbitrary URL was captured or verified by this run.
 */
export function compactResearchCitations(
  content: string,
  sources: readonly ResearchCitationSource[] = [],
): string {
  const source = String(content ?? '').replace(/\r\n?/gu, '\n').trim();
  if (!source) return source;

  const lines = source.split('\n');
  const referenceSection = findReferenceSection(lines);
  const sourceTitles = new Map<string, string>();
  const knownSourceHrefs = new Set<string>();
  for (const item of sources) {
    const href = typeof item.href === 'string' ? normalizeCitationHref(item.href) : '';
    const title = cleanCitationTitle(item.title ?? '');
    if (!href) continue;
    knownSourceHrefs.add(href);
    if (!sourceTitles.has(href)) sourceTitles.set(href, title || sourceHost(href));
  }

  // Existing bibliography labels are useful as a fallback title, but they do
  // not become citations by themselves. A body citation is still required.
  const existingReferenceTitles = new Map<string, string>();
  scanMarkdownLines(lines, (line, lineIndex) => {
    if (!isInReferenceSection(lineIndex, referenceSection)) return;
    for (const token of extractCitationTokens(line)) {
      const href = normalizeCitationHref(token.href);
      if (!href || !token.replaceable || !isKnownSource(href, knownSourceHrefs)) continue;
      const title = cleanCitationTitle(token.label ?? '');
      if (title && !existingReferenceTitles.has(href)) existingReferenceTitles.set(href, title);
    }
  });

  const citations: Citation[] = [];
  const citationIndex = new Map<string, number>();
  const addCitation = (token: CitationToken): number | null => {
    const href = normalizeCitationHref(token.href);
    if (!href || !token.replaceable || !isKnownSource(href, knownSourceHrefs)) return null;
    const existing = citationIndex.get(href);
    if (existing !== undefined) return existing;

    const title = sourceTitles.get(href)
      ?? existingReferenceTitles.get(href)
      ?? cleanCitationTitle(token.label ?? '')
      ?? sourceHost(href);
    const index = citations.push({ href: token.href, title: title || sourceHost(href) }) - 1;
    citationIndex.set(href, index);
    return index;
  };

  // First pass: only links visible in the report body receive inline markers.
  // Keeping reference-section links out of this pass prevents a bibliography
  // from turning into a list of self-referential markers.
  const transformedLines = [...lines];
  scanMarkdownLines(lines, (line, lineIndex) => {
    if (isInReferenceSection(lineIndex, referenceSection)) return;
    const tokens = extractCitationTokens(line);
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    for (const token of tokens) {
      const index = addCitation(token);
      if (index === null) continue;
      replacements.push({
        start: token.start,
        end: token.end,
        value: `[${index + 1}](#bib-${index + 1})`,
      });
    }
    transformedLines[lineIndex] = applyReplacements(line, replacements);
  });

  // Do not add a bibliography to a report that had no source-backed body
  // citation. This preserves ordinary Markdown and keeps unsupported links
  // visibly unverified instead of silently promoting them.
  if (citations.length === 0) return source;

  // Preserve any captured links from an existing reference section after the
  // body citations. This avoids dropping useful source entries while still
  // normalizing their presentation and deduplicating repeated URLs.
  scanMarkdownLines(lines, (line, lineIndex) => {
    if (!isInReferenceSection(lineIndex, referenceSection)) return;
    for (const token of extractCitationTokens(line)) addCitation(token);
  });

  const referenceHeading = referenceSection
    ? lines[referenceSection.start]?.trim() || '## 参考文献'
    : '## 参考文献';
  const references = citations.map((citation, index) => (
    `- **[${index + 1}]** [${escapeMarkdownLabel(citation.title)}](<${citation.href}>)`
  ));
  const referenceBlock = [referenceHeading, '', ...references].join('\n');

  if (!referenceSection) {
    return `${transformedLines.join('\n').trimEnd()}\n\n${referenceBlock}`.trim();
  }

  const before = transformedLines.slice(0, referenceSection.start).join('\n').trimEnd();
  const after = transformedLines.slice(referenceSection.end).join('\n').trim();
  return [before, referenceBlock, after].filter(Boolean).join('\n\n').trim();
}

function isKnownSource(href: string, knownSourceHrefs: Set<string>): boolean {
  return knownSourceHrefs.has(href);
}

function findReferenceSection(lines: string[]): ReferenceSection | null {
  let inFence: { marker: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]![0]!;
      if (!inFence) {
        inFence = { marker, length: fence[1]!.length };
      } else if (inFence.marker === marker && fence[1]!.length >= inFence.length) {
        inFence = null;
      }
      continue;
    }
    if (inFence) continue;
    const heading = REFERENCE_HEADING.exec(line);
    if (!heading) continue;
    const level = heading[1]!.length;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextHeading = /^(\s{0,3})(#{1,6})\s+.*$/u.exec(lines[next] ?? '');
      if (nextHeading && nextHeading[2]!.length <= level) {
        end = next;
        break;
      }
    }
    return { start: index, end };
  }
  return null;
}

function isInReferenceSection(index: number, section: ReferenceSection | null): boolean {
  return Boolean(section && index >= section.start && index < section.end);
}

function scanMarkdownLines(lines: string[], callback: (line: string, lineIndex: number) => void): void {
  let inFence: { marker: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]![0]!;
      if (!inFence) {
        inFence = { marker, length: fence[1]!.length };
      } else if (inFence.marker === marker && fence[1]!.length >= inFence.length) {
        inFence = null;
      }
      continue;
    }
    if (inFence || /^ {4}|^\t/u.test(line)) continue;
    callback(line, index);
  }
}

function extractCitationTokens(line: string): CitationToken[] {
  const ranges = inlineCodeRanges(line);
  const tokens: CitationToken[] = [];
  const occupied: Array<{ start: number; end: number }> = [];

  const addToken = (token: CitationToken) => {
    if (ranges.some((range) => token.start >= range.start && token.start < range.end)) return;
    if (occupied.some((range) => token.start < range.end && token.end > range.start)) return;
    occupied.push({ start: token.start, end: token.end });
    tokens.push(token);
  };

  const markdownLink = /(!?)\[([^\]\n]+)\]\((?:<([^>\n]+)>|([^\s)\n]+))\)/gu;
  for (const match of line.matchAll(markdownLink)) {
    const start = match.index ?? 0;
    const href = match[3] ?? match[4] ?? '';
    addToken({
      start,
      end: start + match[0].length,
      href,
      label: match[2],
      replaceable: match[1] !== '!' && isHttpUrl(href),
    });
  }

  const angleLink = /<(https?:\/\/[^>\s]+)>/giu;
  for (const match of line.matchAll(angleLink)) {
    const start = match.index ?? 0;
    const href = match[1] ?? '';
    addToken({
      start,
      end: start + match[0].length,
      href,
      label: href,
      replaceable: isHttpUrl(href),
    });
  }

  const bareUrl = /https?:\/\/[^\s<>()]+/giu;
  for (const match of line.matchAll(bareUrl)) {
    const raw = match[0] ?? '';
    const start = match.index ?? 0;
    let href = raw;
    while (TRAILING_URL_PUNCTUATION.test(href)) href = href.slice(0, -1);
    if (!href) continue;
    addToken({
      start,
      end: start + href.length,
      href,
      label: href,
      replaceable: isHttpUrl(href),
    });
  }

  return tokens.sort((left, right) => left.start - right.start);
}

function inlineCodeRanges(line: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let openingStart = -1;
  let openingLength = 0;
  for (let index = 0; index < line.length;) {
    if (line[index] !== '`') {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < line.length && line[end] === '`') end += 1;
    const length = end - index;
    if (openingStart < 0) {
      openingStart = index;
      openingLength = length;
    } else if (length === openingLength) {
      ranges.push({ start: openingStart, end });
      openingStart = -1;
      openingLength = 0;
    }
    index = end;
  }
  if (openingStart >= 0) ranges.push({ start: openingStart, end: line.length });
  return ranges;
}

function applyReplacements(line: string, replacements: Array<{ start: number; end: number; value: string }>): string {
  if (replacements.length === 0) return line;
  let output = line;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function normalizeCitationHref(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }
    return url.toString().replace(/\/$/u, '');
  } catch {
    return '';
  }
}

function cleanCitationTitle(value: string): string {
  const cleaned = cleanResearchLabel(value)
    .replace(/[*_~`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned || '';
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]*_~`])/gu, '\\$1');
}

function sourceHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./iu, '');
  } catch {
    return '来源';
  }
}
