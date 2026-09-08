import { cleanResearchText } from './research-markdown-cleanup';

const LATEX_TEXT_COMMAND = /\\(?:textbf|textit|emph|texttt|textrm|textsf|textsc|textnormal|underline)\{([^{}\n]*)\}/gu;
const EXTRACTED_FOOTNOTE_SPAN = /(?:^|[\n ])[*_~`†‡⁎✝0-9\s]{0,24}footnotetext\s*:\s*.*?(?=\s+(?:#{1,6}\s|!\[|[*_~`†‡⁎✝0-9\s]{0,24}footnotetext\s*:)|$)/gimsu;

/**
 * Remove footnote markers that leak from arXiv HTML/PDF extraction.
 *
 * These markers are metadata from the author block, not article prose. The
 * extractor may prefix them with daggers, digits, Markdown emphasis, or
 * place several footnotes before the next heading/figure.
 */
export function stripExtractedPaperFootnotes(content: string): string {
  return content
    .replace(EXTRACTED_FOOTNOTE_SPAN, '\n')
    .replace(/footnotemark\s*:\s*/giu, '')
    .replace(/\n{3,}/gu, '\n\n');
}

/**
 * Clean plain-text fields produced by arXiv/PDF extraction.
 *
 * These fields are rendered as ordinary text in cards, so returning Markdown
 * emphasis markers here would expose the cleanup itself to the reader.
 */
export function cleanExtractedPlainText(content: string): string {
  let value = cleanResearchText(stripExtractedPaperFootnotes(content));
  for (let pass = 0; pass < 3; pass += 1) {
    const next = value
      .replace(LATEX_TEXT_COMMAND, '$1')
      .replace(/\\href\{([^{}\n]+)\}\{([^{}\n]*)\}/gu, '$2')
      .replace(/\\url\{([^{}\n]+)\}/gu, '$1');
    if (next === value) break;
    value = next;
  }
  return value
    .replace(/\\([_&#{}$])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function repairMissingTableSeparators(source: string): string {
  const lines = source.split('\n').flatMap((line) => {
    const joinedHeading = line.match(/^(#{1,6}\s+[^|\n]+)(\|(?:[^|\n]*\|){2,})\s*$/u);
    return joinedHeading ? [joinedHeading[1]!.trimEnd(), '', joinedHeading[2]!.trim()] : [line];
  });
  const repaired: string[] = [];
  const isPipeRow = (line: string) => /^\s*\|(?:[^|\n]*\|){2,}\s*$/u.test(line);
  const isSeparatorRow = (line: string) => /^\s*\|(?:\s*:?-{3,}:?\s*\|){2,}\s*$/u.test(line);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const previous = lines[index - 1] ?? '';
    const next = lines[index + 1] ?? '';
    if (isSeparatorRow(line) && !isPipeRow(previous)) continue;
    repaired.push(line);
    if (isPipeRow(previous) || !isPipeRow(line) || !isPipeRow(next) || isSeparatorRow(next)) continue;
    const columnCount = line.split('|').slice(1, -1).length;
    repaired.push(`| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`);
  }
  return repaired.join('\n');
}

function normalizeKatexColors(formula: string): string {
  return formula.replace(
    /\\color\[rgb\]\{([\d.]+),([\d.]+),([\d.]+)\}/gu,
    (_match, red: string, green: string, blue: string) => {
      const channel = (value: string) => Math.round(
        Math.min(1, Math.max(0, Number.parseFloat(value))) * 255,
      ).toString(16).padStart(2, '0');
      return `\\color{#${channel(red)}${channel(green)}${channel(blue)}}`;
    },
  );
}

function normalizeInlineTableFormula(formula: string): string {
  return normalizeKatexColors(formula)
    .replace(/\\begin\{split\}/gu, String.raw`\begin{aligned}`)
    .replace(/\\end\{split\}/gu, String.raw`\end{aligned}`)
    .replace(/\\tag\{([^{}]+)\}/gu, String.raw`\qquad\text{($1)}`);
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const body = trimmed.slice(1, -1);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '|' && body[index - 1] !== '\\') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return Boolean(cells?.length && cells.every((cell) => /^:?-{3,}:?$/u.test(cell)));
}

function isMathCell(cell: string): boolean {
  return /\$\$[\s\S]*\$\$/u.test(cell) || /\$[^$\n]+\$/u.test(cell);
}

function repairArxivTemplatePlaceholders(source: string): string {
  return source
    .replace(/推荐五款最值得买的\s+s\b/gu, '推荐五款最值得买的 [产品]')
    .replace(/Recommend the top five most worth-buying\s+s\b/giu, 'Recommend the top five most worth-buying [product]')
    .replace(/推荐五款口碑较好的\s+s\b/gu, '推荐五款口碑较好的 [产品]')
    .replace(/推荐深圳最值得去的五家\s+s\b/gu, '推荐深圳最值得去的五家 [商家]')
    .replace(/推荐五款最值得关注的\s+s\b/gu, '推荐五款最值得关注的 [产品]');
}

function isEquationNumber(cell: string): boolean {
  return /^\([A-Za-z0-9.:-]+\)$/u.test(cell);
}

function unwrapEquationTables(source: string): string {
  const lines = source.split('\n');
  const output: string[] = [];
  const stripMathDelimiters = (cell: string) => cell
    .replace(/^\$\$\s*/u, '')
    .replace(/\s*\$\$$/u, '')
    .replace(/^\$\s*/u, '')
    .replace(/\s*\$$/u, '')
    .trim();

  for (let index = 0; index < lines.length;) {
    const firstRow = splitMarkdownTableRow(lines[index] ?? '');
    const separator = lines[index + 1];
    if (!firstRow || !separator || !isMarkdownTableSeparator(separator)) {
      output.push(lines[index] ?? '');
      index += 1;
      continue;
    }

    const rows: string[][] = [];
    let end = index;
    while (end < lines.length) {
      const row = splitMarkdownTableRow(lines[end] ?? '');
      if (!row) break;
      if (!isMarkdownTableSeparator(lines[end] ?? '')) rows.push(row);
      end += 1;
    }

    const equationRows = rows.filter((row) => row.some((cell) => cell.trim()));
    if (equationRows.length === 0) {
      output.push('');
      index = end;
      continue;
    }
    const isEquationTable = equationRows.every((row) => {
      const meaningful = row.map((cell) => cell.trim()).filter(Boolean);
      return meaningful.some(isMathCell)
        && meaningful.every((cell) => isMathCell(cell) || isEquationNumber(cell));
    });
    if (!isEquationTable) {
      output.push(lines[index] ?? '');
      index += 1;
      continue;
    }

    for (const row of equationRows) {
      const meaningful = row.map((cell) => cell.trim()).filter(Boolean);
      const formula = meaningful.filter(isMathCell).map(stripMathDelimiters).join(' ').trim();
      if (!formula) continue;
      const number = meaningful.find(isEquationNumber);
      output.push(`$$\n${formula}${number ? `\\tag{${number.slice(1, -1)}}` : ''}\n$$`);
      output.push('');
    }
    index = end;
  }
  return output.join('\n');
}

function cleanImageExtractionArtifacts(source: string): string {
  const imageLine = /^(?<indent>\s*)(?:[✕×]\s*)?(?<image>!\[[^\]]*\]\([^)]+\))(?<tail>.*)$/u;
  const imageAlt = (image: string): string => image.match(/^!\[([^\]]*)\]/u)?.[1]?.trim() ?? '';
  const lines = source.split('\n');
  const cleaned: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*[✕×]\s*$/u.test(line) && /^\s*!\[[^\]]*\]\([^)]+\)/u.test(lines[index + 1] ?? '')) {
      continue;
    }

    const match = line.match(imageLine);
    if (!match?.groups) {
      cleaned.push(line);
      continue;
    }

    const indent = match.groups.indent ?? '';
    const image = match.groups.image ?? '';
    const tail = (match.groups.tail ?? '').trimStart();
    if (!tail) {
      cleaned.push(line);
      continue;
    }

    const alt = imageAlt(image);
    const articleText = alt && tail.startsWith(alt)
      ? tail.slice(alt.length).trimStart().replace(/^[.!?。！？]\s*/u, '')
      : tail;
    cleaned.push(`${indent}${image}`);
    if (articleText) {
      cleaned.push('', `${indent}${articleText}`);
    }
  }

  return cleaned.join('\n');
}

/**
 * Normalize extracted research text without importing the React Markdown
 * renderer. Radar outlines use this same function before the renderer chunk
 * is needed, keeping the first visit bundle focused on page chrome and data.
 */
export function prepareContent(content: string): string {
  let source = cleanResearchText(content).replace(/\r\n?/g, '\n').trim();
  if (!source) return '';

  source = stripExtractedPaperFootnotes(source)
    .replace(/\n{3,}/gu, '\n\n');

  const latexInline = (value: string): string => {
    let normalized = value;
    for (const [pattern, marker] of [
      [/\\textbf\{([^{}\n]*)\}/g, '**'],
      [/\\textit\{([^{}\n]*)\}/g, '*'],
      [/\\emph\{([^{}\n]*)\}/g, '*'],
      [/\\texttt\{([^{}\n]*)\}/g, '`'],
    ] as const) {
      normalized = normalized.replace(pattern, (_match, inner: string) => `${marker}${inner}${marker}`);
    }
    normalized = normalized.replace(/\\href\{([^{}\n]+)\}\{([^{}\n]*)\}/g, '[$2]($1)');
    normalized = normalized.replace(/\\url\{([^{}\n]+)\}/g, '<$1>');
    return normalized.replace(/\\([_&#{}$])/g, '$1');
  };
  source = latexInline(source);
  source = repairArxivTemplatePlaceholders(source);
  source = unwrapEquationTables(source);
  source = source.replace(
    /(^|\n)[ \t]*[✕×][ \t]*(?=\n[ \t]*!\[)/gu,
    '$1',
  );
  source = cleanImageExtractionArtifacts(source);
  source = source.replace(/\\\*\\\*/gu, '**');

  const protectedUrls: string[] = [];
  const protectUrls = (value: string): string => value.replace(
    /https?:\/\/[^\s)]+/gu,
    (url) => {
      const index = protectedUrls.push(url) - 1;
      return `RADARURLTOKEN${index}END`;
    },
  );
  const restoreUrls = (value: string): string => value.replace(
    /RADARURLTOKEN(\d+)END/gu,
    (_match, index: string) => protectedUrls[Number(index)] ?? _match,
  );

  source = protectUrls(source);
  source = source
    .replace(/(\]\([^)\n]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|__[^_\n]+__|_[^_\n]+_|`[^`\n]+`)(?=[A-Za-z])/gu, '$1 ')
    .replace(/(\]\([^)\n]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|__[^_\n]+__|_[^_\n]+_|`[^`\n]+`)\n(?=\[[^\]]+\]\()/gu, '$1 ')
    .replace(/(^|[\s([{（【，,；;：:])\*\*[ \t]+([^*\n]+?)\*\*/gmu, '$1**$2**')
    .replace(/(?<!\*)\*\s+([^*\n]+)\*(?!\*)/gu, '*$1*')
    .replace(/\n{2,}/gu, '\n\n');
  source = restoreUrls(source);
  source = source
    .replace(/(^|[\s([{（【，,；;：:])\*\*[ \t]+([^*\n]+?)\s*\*\*/gmu, '$1**$2**')
    .replace(/(?<!\*)\*\s+([^*\n]+?)\s*\*(?!\*)/gu, '*$1*')
    .replace(/(\*\*[^*\n]+\*\*)(?=[A-Za-z])/gu, '$1 ');

  source = source
    .split('\n')
    .map((line) => line.includes('|')
      ? line.replace(
        /\$\$\s*([^$\n]+?)\s*\$\$/gu,
        (_match, formula: string) => `$\\displaystyle ${normalizeInlineTableFormula(formula)}$`,
      )
      : line)
    .join('\n');
  source = repairMissingTableSeparators(source);
  source = source.replace(
    /(^|\n)\s*\*\*\s*TL;?DR\s*([-–—:：])\s*([^\n]+?)(?=\n|$)/giu,
    (_match, prefix: string, separator: string, rawTakeaway: string) => {
      const takeaway = rawTakeaway.trim().replace(/^(\*\*|__)\s+/u, '$1');
      const isMarkedTakeaway = /^(?:\*\*|__|\*|_|\[[^\]]+\]\(|`)/u.test(takeaway);
      const isBulletSeparator = separator === '-';
      return `${prefix}**TL;DR**\n\n${isBulletSeparator && isMarkedTakeaway ? `- ${takeaway}` : takeaway}`;
    },
  );
  const markdownBlocks = source.split(/\n{2,}/u);
  const startsBlockSyntax = (value: string): boolean => /^(?:#{1,6}\s|[-*+]\s|>\s|```|~~~|\|)/u.test(value.trim());
  const startsInlineMarkdown = (value: string): boolean => /^(?:\[[^\]]+\]\(|\*\*[^*\n]+\*\*|\*[^*\n]+\*|__[^_\n]+__|_[^_\n]+_|`[^`\n]+`)/u.test(value.trim());
  const inlineText = (value: string): string => value.trim().replace(/^(?:\*\*|__|\*|_|`)|(?:\*\*|__|\*|_|`)$/gu, '').trim();
  const isStandaloneLabel = (value: string): boolean => /^(?:tl;?dr|abstract|摘要|目录|参考文献)$/iu.test(inlineText(value));
  const mergedBlocks: string[] = [];
  for (const block of markdownBlocks) {
    const trimmed = block.trim();
    const previous = mergedBlocks.at(-1);
    if (
      previous
      && trimmed
      && !startsBlockSyntax(previous)
      && !startsBlockSyntax(trimmed)
      && startsInlineMarkdown(trimmed)
      && !isStandaloneLabel(previous.trim())
      && !isStandaloneLabel(trimmed)
      && !/^\(\d+\)$/u.test(previous.trim())
      && (!/[.!?。！？]$/u.test(trimmed) || inlineText(trimmed).length <= 80)
      && !/[.!?。！？]$/u.test(previous.trim())
    ) {
      mergedBlocks[mergedBlocks.length - 1] = `${previous.trim()} ${trimmed}`;
    } else if (trimmed) {
      mergedBlocks.push(trimmed);
    }
  }
  source = mergedBlocks.join('\n\n');

  const stripUnescapedLatexComments = (formula: string): string => formula
    .split('\n')
    .map((line) => {
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] !== '%') continue;
        let slashCount = 0;
        for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
          slashCount += 1;
        }
        if (slashCount % 2 === 0) return line.slice(0, index).trimEnd();
      }
      return line;
    })
    .join('\n');
  const normalizeMath = (formula: string): string => normalizeKatexColors(stripUnescapedLatexComments(formula))
    .replace(/\\middle\\\\\|/gu, '\\middle|')
    .replace(/\\text\{\\?\$\}/gu, String.raw`\$`)
    .replace(/(?<!\\)\$(?=\d)/gu, String.raw`\$`);
  source = source.replace(/\$\$([\s\S]*?)\$\$/gu, (_match, formula: string) => `$$${normalizeMath(formula)}$$`);
  source = source.replace(/(?<![\\$])\$([^$\n]+)\$(?!\$)/gu, (_match, formula: string) => `$${normalizeMath(formula)}$`);
  source = source.replace(/\$\$\s*\|\s*\|/gu, '| |');
  source = source.replace(
    /\$\$((?:(?!\$\$)[\s\S])*?)\$\$\s*\n{1,3}\s*\((\d+)\)(?=\s*(?:\n|$))/gu,
    (_match, formula: string, number: string) => {
      if (/\\tag\s*\{/u.test(formula)) return _match;
      return `$$\n${formula.trim()}\\tag{${number}}\n$$`;
    },
  );

  const rewriteReferenceLine = (line: string): string => {
    if (line.includes('](')) return line;
    const urlMatch = line.match(/(https?:\/\/\S+?)([).,;:!?]*)$/u);
    if (!urlMatch || urlMatch.index === undefined) return line;
    const [, url, trailingPunctuation = ''] = urlMatch;
    const prefix = line.slice(0, urlMatch.index).trimEnd();
    if (!prefix) return line;

    const footnoteMatch = prefix.match(/^(\[\^[^\]]+\]:)\s+(.+)$/u);
    if (footnoteMatch) {
      const [, marker, label] = footnoteMatch;
      return `${marker} [${label.trim()}](${url})${trailingPunctuation}`;
    }

    const orderedMatch = prefix.match(/^(\d+\.)\s+(.+)$/u);
    if (orderedMatch) {
      const [, marker, label] = orderedMatch;
      return `${marker} [${label.trim()}](${url})${trailingPunctuation}`;
    }

    return line;
  };
  source = source.split('\n').map((line) => rewriteReferenceLine(line.trim())).join('\n');
  source = source.replace(
    /(^|[\s([{（【，,；;：:])\*\*[ \t]+([^*\n]+?)\s*\*\*/gmu,
    '$1**$2**',
  );
  source = source.replace(
    /(?<!\*)(\*(?!\*)[^*\n]+\*(?!\*))(?=[A-Za-z])/gu,
    '$1 ',
  );
  source = source
    .replace(/\*\s*categories(?:\*)?\s*of\s+15\s*(?:\*\s*)?products\*/giu, 'categories of 15 products')
    .replace(/((?:\*|_)?(?:scenarios|categories|products)(?:\*|_)?)(?=\()/giu, '$1 ');

  const hasMarkdownStructure = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|>\s|```|~~~|\|.+\|)/m.test(source)
    || /\*\*|__|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\)|\$\$[\s\S]*?\$\$/.test(source);
  if (hasMarkdownStructure) return source;

  const sectionLabels = [
    'Execution: Did the agent follow its instructions?',
    'Outcome: Did the interaction achieve its intended goal?',
    'Experience: Was the conversation a smooth experience for the caller?',
    'Use deterministic evaluators for explicit requirements',
    'Use LLM judges for semantic requirements',
    'Evaluate qualitative outcomes with LLM judges',
    'Measure downstream business outcomes',
    'Measure responsiveness',
  ];
  for (const label of sectionLabels) {
    const firstDimensionLabel = label.startsWith('Execution:') || label.startsWith('Outcome:') || label.startsWith('Experience:');
    const start = firstDimensionLabel ? source.indexOf(label, source.indexOf(label) + label.length) : source.indexOf(label);
    if (start >= 0) {
      source = `${source.slice(0, start)}\n\n## ${label}\n\n${source.slice(start + label.length)}`;
    }
  }

  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  const normalizedLines = lines.map(rewriteReferenceLine);
  const output: string[] = [];
  let paragraph = '';
  const flush = () => {
    if (paragraph) output.push(paragraph);
    paragraph = '';
  };
  const heading = /^(abstract|introduction|background|method(?:s)?|results?|discussion|conclusion|references|\d+(?:\.\d+)*\s+.+)$/i;

  for (const line of normalizedLines) {
    if (line.startsWith('## ')) {
      flush();
      output.push(line);
      continue;
    }
    if (heading.test(line) && line.length < 100) {
      flush();
      output.push(`## ${line}`);
      continue;
    }
    paragraph = paragraph ? `${paragraph} ${line}` : line;
    while (paragraph.length >= 560) {
      const tail = paragraph.slice(430);
      const match = tail.search(/[。！？.!?](?=\s|$)/);
      if (match < 0) break;
      const cut = 430 + match + 1;
      output.push(paragraph.slice(0, cut).trim());
      paragraph = paragraph.slice(cut).trim();
    }
  }
  flush();
  return output.join('\n\n');
}
