import { prepareContent } from '@/components/MarkdownContent';

export function decodeRadarTextEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    quot: '"',
  };
  const decodeCodePoint = (match: string, raw: string, radix: number): string => {
    const codePoint = Number.parseInt(raw, radix);
    return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match;
  };
  return value
    .replace(/&#x([0-9a-f]+);/giu, (match, hex: string) => decodeCodePoint(match, hex, 16))
    .replace(/&#(\d+);/gu, (match, decimal: string) => decodeCodePoint(match, decimal, 10))
    .replace(/&([a-z]+);/giu, (match, name: string) => named[name.toLowerCase()] ?? match);
}

/** Decode literal JSON unicode escapes that may exist in persisted metadata. */
export function decodeRadarTextEscapes(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded.replace(/\\+u([0-9a-f]{4})/giu, (_match, hex: string) => (
      String.fromCharCode(Number.parseInt(hex, 16))
    ));
    if (next === decoded) break;
    decoded = next;
  }
  return decodeRadarTextEntities(decoded);
}

function normalizeLeadText(value: string): string {
  return decodeRadarTextEntities(value)
    .normalize('NFKC')
    .replace(/^#{1,6}\s+/u, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`~]/gu, '')
    .replace(/[（(][^()（）]{0,120}[）)]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

function removeSourceTitle(content: string, title?: string, paperMode = false): string {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return content;
  const heading = lines[first]!.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
  if (!heading) return content;
  const exactTitle = title && normalizeLeadText(heading[2] ?? '') === normalizeLeadText(title);
  if (!exactTitle && !(paperMode && heading[1] === '#')) return content;
  return lines.slice(first + 1).join('\n').trimStart();
}

function removePaperFrontMatter(content: string): string {
  const blocks = content.split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean);
  const abstractIndex = blocks.findIndex((block, index) => (
    index < 8 && /^#{1,6}\s+(?:abstract|摘要)\b/iu.test(block)
  ));
  return abstractIndex > 0 ? blocks.slice(abstractIndex).join('\n\n') : content;
}

function normalizePaperReaderArtifacts(content: string): string {
  return content
    // A converted arXiv appendix can leak a model-instruction template into
    // the reader. Remove only the exact artifact signature.
    .replace(
      /\{\{\s*content\s*\|\s*trim\s*\}\}\s*You FIRST think about the reasoning process as an internal monologue and then provide the final answer\.\s*The reasoning process MUST BE enclosed within <think>\s*<\/think> tags\.\s*The final answer MUST BE put in \\boxed\s*\{\}\.?/giu,
      '',
    )
    // Appendix prompt templates in some arXiv papers use a bare `s` as a
    // mathematical placeholder. Make the substitution explicit for readers
    // without changing the stored source Markdown used for citations.
    .replace(
      /Each template substitutes the product name\s+(?:\$s\$|s)\s+into a scenario-specific phrasing\./giu,
      'Each template substitutes a product or service name into a scenario-specific phrasing.',
    )
    .replace(
      /推荐五款最值得买的\s+(?:\$s\$|s)\s*\(“Recommend the top five most worth-buying\s+(?:\$s\$|s)”\)/giu,
      '推荐五款最值得买的 [产品] (“Recommend the top five most worth-buying [product]”)',
    )
    .replace(
      /推荐五款口碑较好的\s+(?:\$s\$|s)\s*\(“well-regarded”\)/giu,
      '推荐五款口碑较好的 [产品] (“well-regarded”)',
    )
    .replace(
      /推荐深圳最值得去的五家\s+(?:\$s\$|s)\s*\(“most worth-visiting\s+(?:\$s\$|s) in Shenzhen”\)/giu,
      '推荐深圳最值得去的五家 [店铺/服务] (“most worth-visiting places/services in Shenzhen”)',
    )
    .replace(
      /推荐五款最值得关注的\s+(?:\$s\$|s)\s*\(“most worth-attention”\)/giu,
      '推荐五款最值得关注的 [产品] (“most worth-attention [products]”)',
    )
    // Older arXiv HTML extraction could split inline emphasis around a
    // phrase, leaving a visible `categoriesof` fragment in the reader.
    .replace(/\*\s+categoriesof\s+15\s+products\*/giu, 'categories of 15 products')
    .replace(/\b(scenarios|categories|products)\((?=[A-Z])/gu, '$1 (');
}

function removeDuplicateLead(content: string): string {
  const blocks = content.split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean);
  const proseIndexes = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => !/^(?:#{1,6}\s|[-*+]\s|>\s|```|~~~|\|)/u.test(block))
    .slice(0, 2);
  if (proseIndexes.length < 2) return content;

  const [first, second] = proseIndexes;
  if (!first || !second || first.index > 2 || second.index !== first.index + 1) return content;
  const shortLead = normalizeLeadText(first.block);
  const longLead = normalizeLeadText(second.block);
  if (shortLead.length < 16 || shortLead.length > 140 || longLead.length <= shortLead.length) return content;
  if (!longLead.startsWith(shortLead)) return content;

  return blocks.filter((_block, index) => index !== first.index).join('\n\n');
}

export function prepareRadarReadingContent(
  content: string,
  title?: string,
  paperMode = false,
): string {
  let prepared = removeSourceTitle(content, title, paperMode);
  if (paperMode) {
    prepared = removePaperFrontMatter(prepared);
    prepared = normalizePaperReaderArtifacts(prepared);
  }
  return removeDuplicateLead(prepared);
}

export function hasRadarReadingOutline(content: string, paperMode = false): boolean {
  const source = prepareContent(content);
  const headingPattern = paperMode ? /^#{1,6}\s+\S+/u : /^#{2,3}\s+\S+/u;
  return source.split('\n').filter((line) => headingPattern.test(line.trim())).length >= 2;
}

export function splitRadarReadingBlocks(content: string): string[] {
  const prepared = prepareContent(content);
  const lines = prepared.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: 'backtick' | 'tilde' | null = null;
  let mathBlock = false;

  const flush = () => {
    const block = current.join('\n').trim();
    if (block) blocks.push(block);
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const kind = fenceMatch[1]!.startsWith('`') ? 'backtick' : 'tilde';
      if (fence === null) fence = kind;
      else if (fence === kind) fence = null;
      current.push(line);
      continue;
    }
    if (trimmed.startsWith('$$')) {
      const delimiters = (trimmed.match(/\$\$/gu) ?? []).length;
      if (delimiters % 2 === 1) mathBlock = !mathBlock;
      current.push(line);
      continue;
    }
    if (!trimmed && fence === null && !mathBlock) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

export function radarBlockId(index: number): string {
  return `radar-source-block-${index}`;
}

export function normalizeRadarQuote(value: string): string {
  return value
    .normalize('NFKC')
    // Compare the rendered text with the source quote, not Markdown syntax.
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\\(?:textbf|textit|emph|texttt)\{([^{}]*)\}/gu, '$1')
    .replace(/\\href\{[^{}]+\}\{([^{}]*)\}/gu, '$1')
    .replace(/\\url\{([^{}]*)\}/gu, '$1')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/[\*_`~]/gu, '')
    .replace(/\\([%_&#{}$])/gu, '$1')
    .replace(/\\middle\\\|/gu, '\\middle|')
    .replace(/[\u200B\u200C\u200D]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Return true only when the quote is literally present in this block.
 * A wrong jump is worse than no jump, so short/fuzzy matches are rejected.
 */
export function radarQuoteMatchesBlock(block: string, quote: string): boolean {
  const normalizedBlock = normalizeRadarQuote(block);
  const normalizedQuote = normalizeRadarQuote(quote);
  if (!normalizedBlock || !normalizedQuote) return false;

  return normalizedQuote.length >= 18 && normalizedBlock.includes(normalizedQuote);
}
