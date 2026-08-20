import { prepareContent } from '@/components/MarkdownContent';

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
