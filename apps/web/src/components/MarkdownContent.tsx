import React, { useContext, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import type { Components } from 'react-markdown';
import { ZoomIn } from 'lucide-react';
import MermaidDiagram, { isMermaidSource } from './MermaidDiagram';

import { cn } from '@/lib/utils';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';

const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export type MarkdownLinkClickHandler = (
  href: string,
  event: React.MouseEvent<HTMLAnchorElement>,
) => void;

const MarkdownLinkClickContext = React.createContext<MarkdownLinkClickHandler | undefined>(undefined);

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
    const isEquationTable = equationRows.length > 0 && equationRows.every((row) => {
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

function ReferenceLink({
  href,
  children,
  className,
  label = '参考文献',
  ...props
}: {
  href?: string;
  children?: React.ReactNode;
  className?: string;
  label?: string;
  [key: string]: unknown;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const isReference = Boolean(href?.startsWith('#bib') || href?.startsWith('#user-content-fn-'));
  const external = href?.startsWith('https://') || href?.startsWith('http://');

  if (!isReference) {
    return (
      <a
        {...props}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer noopener' : undefined}
        className={className}
      >
        {children}
      </a>
    );
  }

  const showPreview = () => {
    const targetId = href?.slice(1);
    const target = targetId ? document.getElementById(targetId) : null;
    setPreview(target?.textContent?.replace(/\s+/gu, ' ').trim().slice(0, 360) || '正文中暂未找到对应参考文献。');
  };

  return (
    <span className="relative inline-block" onMouseEnter={showPreview} onMouseLeave={() => setPreview(null)}>
      <a
        {...props}
        href={href}
        className={className}
        onFocus={showPreview}
        onBlur={() => setPreview(null)}
      >
        {children}
      </a>
      {preview ? (
        <span
          role="tooltip"
          className="absolute bottom-full left-1/2 z-50 mb-2 w-72 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-left text-xs font-normal leading-5 text-popover-foreground shadow-lg"
        >
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-primary">{label}</span>
          {preview}
        </span>
      ) : null}
    </span>
  );
}

function safeMarkdownUrl(value: string): string {
  try {
    const parsed = new URL(value, 'https://markdown.invalid');
    if (SAFE_URL_PROTOCOLS.has(parsed.protocol)) return value;
  } catch {
    // Invalid URLs are omitted by react-markdown.
  }
  return '';
}

function isSafeImageSource(value: string): boolean {
  const isMissingArxivImage = /^https:\/\/(?:arxiv\.org|ar5iv\.labs\.arxiv\.org)\/html\/\d{4}\.\d{4,6}(?:v\d+)?$/iu.test(value);
  return !isMissingArxivImage && (
    /^https?:\/\//iu.test(value)
    || /^data:image\/svg\+xml;base64,[a-z0-9+/]+={0,2}(?:#[a-z0-9_.-]+)?$/iu.test(value)
  );
}

function transformMarkdownUrl(value: string, key: string): string {
  if (key === 'src' && isSafeImageSource(value)) return value;
  return safeMarkdownUrl(value);
}

/**
 * Source extraction frequently returns hard-wrapped plain text rather than
 * authored Markdown (especially PDF/arXiv). ReactMarkdown cannot infer
 * paragraphs from those wraps, so reflow that narrow case into readable
 * paragraphs while leaving real Markdown untouched.
 */
export function prepareContent(content: string): string {
  let source = content.replace(/\r\n?/g, '\n').trim();
  if (!source) return '';

  // arXiv/Hugging Face pages occasionally pass LaTeX inline commands through
  // an HTML-to-Markdown extractor, producing text such as
  // `\\textbf{[title](url)}`. Normalize the common presentation commands
  // before ReactMarkdown sees them. This is intentionally narrow: equations
  // and unknown TeX macros are left untouched rather than guessed.
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
    return normalized.replace(/\\([%_&#{}$])/g, '$1');
  };
  source = latexInline(source);
  // Some arXiv examples lose the named template variable and leave a bare
  // `s` in the reader-facing sentence. Restore an explicit placeholder.
  source = repairArxivTemplatePlaceholders(source);
  // arXiv HTML extraction can flatten display equations into GFM tables so
  // the original TeX columns survive. They are not authored data tables:
  // restore those rows to display math before remark-gfm parses the source.
  source = unwrapEquationTables(source);

  // Some server-rendered Markdown payloads escape strong markers as
  // `\*\*label\*\*`. Restore them before the spacing/inline normalization
  // passes so react-markdown can render emphasis instead of literal asterisks.
  source = source.replace(/\\\*\\\*/gu, '**');

  // Web HTML-to-Markdown converters sometimes promote inline elements to
  // separate paragraphs. That produces reader-hostile fragments such as
  // "we compared" / "**with**" / "[ALTK-Evolve]...". Restore the spaces
  // between inline Markdown nodes and join only continuation-like blocks;
  // headings, lists, quotes, tables and code fences remain independent.
  source = source
    .replace(/(\]\([^)\n]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|__[^_\n]+__|_[^_\n]+_|`[^`\n]+`)(?=[A-Za-z])/gu, '$1 ')
    .replace(/(\]\([^)\n]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|__[^_\n]+__|_[^_\n]+_|`[^`\n]+`)\n(?=\[[^\]]+\]\()/gu, '$1 ')
    .replace(/\*\*\s+([^*\n]+)\*\*/gu, '**$1**')
    .replace(/(?<!\*)\*\s+([^*\n]+)\*(?!\*)/gu, '*$1*')
    .replace(/\n{2,}/gu, '\n\n');
  // Run the inline-marker cleanup once more after paragraph normalization.
  // Zread pages are split into blocks before rendering, so a marker can
  // arrive at this point in a slightly different shape than in the source
  // payload (for example `** lifecycle hooks**`). Keep this pass idempotent.
  source = source
    .replace(/\*\*\s+([^*\n]+?)\s*\*\*/gu, '**$1**')
    .replace(/(?<!\*)\*\s+([^*\n]+?)\s*\*(?!\*)/gu, '*$1*')
    .replace(/(\*\*[^*\n]+\*\*)(?=[A-Za-z])/gu, '$1 ');
  // GFM tables cannot contain block math delimiters. Extractors commonly
  // place numbered equations in a table row as `$$...$$`, which otherwise
  // renders the delimiters literally. Keep the equation in the cell but
  // make it valid inline math (with displaystyle for readable sizing).
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
  // Some web extractors flatten a bold TL;DR label and its first takeaway
  // into one paragraph. Treat a hyphen as a list marker only when the
  // takeaway itself starts with an authored inline marker (bold/link/etc.);
  // do not turn every `TL;DR- sentence` into a bullet by assumption.
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

  // A few arXiv HTML-to-Markdown paths escape the relation bar twice, e.g.
  // `\\middle\\|`. KaTeX treats that as an invalid command. Normalize only
  // this known extractor artifact and leave intentional LaTeX line breaks
  // untouched.
  const normalizeMath = (formula: string): string => normalizeKatexColors(formula)
    .replace(/\\middle\\\\\|/gu, '\\middle|')
    .replace(/\\text\{\\?\$\}/gu, String.raw`\$`)
    // Currency markers inside a display formula are literal dollars, not
    // nested Markdown math delimiters.
    .replace(/(?<!\\)\$(?=\d)/gu, String.raw`\$`);
  source = source.replace(/\$\$([\s\S]*?)\$\$/gu, (_match, formula: string) => `$$${normalizeMath(formula)}$$`);
  source = source.replace(/(?<![\\$])\$([^$\n]+)\$(?!\$)/gu, (_match, formula: string) => `$${normalizeMath(formula)}$`);
  // A table extractor can leave a delimiter fragment such as `$$ | |` after
  // an inline formula. It is not a formula and must not open a second math
  // span in the following text.
  source = source.replace(/\$\$\s*\|\s*\|/gu, '| |');

  // arXiv extraction can emit a display equation and its number as two
  // separate Markdown paragraphs. Attach the number with KaTeX's \tag so it
  // stays on the same visual row, like the arXiv HTML reader.
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

  // Keep a missing separator after an emphasis fragment from becoming a
  // visible word join (for example `*prompting*and` in arXiv abstracts).
  source = source.replace(
    /(?<!\*)(\*(?!\*)[^*\n]+\*(?!\*))(?=[A-Za-z])/gu,
    '$1 ',
  );

  // Older arXiv HTML extraction could flatten the emphasized phrase
  // `*categories* of 15 *products*` into `* categoriesof 15 products*`.
  // Repair only this known phrase so ordinary authored emphasis is untouched.
  source = source
    .replace(/\*\s*categories(?:\*)?\s*of\s+15\s*(?:\*\s*)?products\*/giu, 'categories of 15 products')
    .replace(/((?:\*|_)?(?:scenarios|categories|products)(?:\*|_)?)(?=\()/giu, '$1 ');

  // M8: 扩大"已格式化 markdown"检测范围。行首标记（标题/列表/引用/代码块/表格）
  // 需要锚定行首；行内标记（**bold** / *italic* / [link](url)）可出现在段落任意处，
  // 单独匹配，避免纯加粗/链接段落被误走 reflow 启发式而排版失真。
  const hasMarkdownStructure = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|>\s|```|~~~|\|.+\|)/m.test(source)
    || /\*\*|__|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\)|\$\$[\s\S]*?\$\$/.test(source);
  if (hasMarkdownStructure) return source;

  // Some web readers return the complete article as one line. Recover the
  // section labels that are stable in the extracted article without trying
  // to hallucinate a heading for every sentence.
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
    // The first three labels also appear in the introductory “three
    // dimensions” sentence. Keep those mentions inline and promote the
    // actual section occurrence (the second one) to a heading.
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
    // Break long extracted runs at sentence boundaries, not at PDF wraps.
    // The source may itself be one very long line, so split inside the line
    // rather than waiting for the line to end.
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

/**
 * MarkdownContent —— 已发布正文的渲染器（调研库详情、雷达详情等）。
 *
 * 排版交给 @tailwindcss/typography 的 `prose`，颜色由 globals.css 里的
 * `--tw-prose-*` token 覆盖（深浅色自动切换）。
 * 这里只保留 prose 默认观感不合适的几个元素覆盖：
 *   - a：强制新窗口打开 + noreferrer（安全要求，不只是样式）
 *   - pre / code：代码块要更紧凑、可折行
 *   - table：需要外层横向滚动容器
 *
 * ⚠️ 与 MarkdownPreview.tsx 是两套东西：那个是 ImportDialog 专用的手写解析器
 * （支持文本选区回调），不走 react-markdown，也不共用这里的样式。
 */
function containsImageNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const candidate = node as { tagName?: string; children?: unknown[] };
  if (candidate.tagName === 'img') return true;
  return candidate.children?.some(containsImageNode) ?? false;
}

const components: Components = {
  // Imported article bodies often contain meaningful single line breaks even
  // when they are not fully-authored Markdown. Preserve those breaks instead
  // of letting the browser collapse the whole body into one dense paragraph.
  // Image-only Markdown is represented as a paragraph containing an image.
  // Our image renderer returns a figure, which cannot legally live inside p.
  p: ({ children, node }) => (
    containsImageNode(node)
      ? <div className="whitespace-pre-line">{children}</div>
      : <p className="whitespace-pre-line">{children}</p>
  ),
  hr: () => <hr className="my-8 border-[var(--ink-rule)]" />,
  img: ({ src, alt, title }) => {
    const imageSrc = typeof src === 'string' ? src : '';
    if (!imageSrc || !isSafeImageSource(imageSrc)) return null;
    const isSvg = imageSrc.startsWith('data:image/svg+xml');
    return (
      <figure className="my-7 overflow-hidden rounded-xl border border-[var(--ink-rule)] bg-[var(--ink-page)]">
        <div className={cn(isSvg && 'overflow-x-auto')}>
          <a
            href={imageSrc}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="在新标签页查看原图"
            className="group relative block w-fit max-w-full mx-auto"
          >
            <img
              src={imageSrc}
              alt={alt ?? ''}
              title={title ?? undefined}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className={cn(
                'mx-auto max-h-[min(70vh,720px)] w-auto object-contain',
                // arXiv figures carry their own scale and may be wider than
                // the reading column. Fit oversized diagrams on desktop
                // after the SVG label correction; keep natural-size
                // inspection on narrow screens where the user can scroll.
                isSvg ? 'max-w-none lg:max-w-full' : 'max-w-full',
              )}
            />
            <span className="pointer-events-none absolute right-2 top-2 grid size-8 place-items-center rounded-md bg-black/55 text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <ZoomIn className="size-4" aria-hidden="true" />
              <span className="sr-only">在新标签页查看原图</span>
            </span>
          </a>
        </div>
        {alt ? <figcaption className="border-t border-[var(--ink-rule)] px-4 py-2 text-center text-xs leading-5 text-muted-foreground">{alt}</figcaption> : null}
      </figure>
    );
  },
  a: ({ href, children, node, className, ...props }) => {
    void node;
    const onLinkClick = useContext(MarkdownLinkClickContext);
    const backref = 'data-footnote-backref' in props;
    if (!backref && (href?.startsWith('#bib') || href?.startsWith('#user-content-fn-'))) {
      return (
        <ReferenceLink
          {...props}
          href={href}
          label={href.startsWith('#bib') ? '参考文献' : '脚注'}
          className={cn(className, 'font-medium text-primary underline decoration-primary/35 underline-offset-2 hover:decoration-primary')}
        >
          {children}
        </ReferenceLink>
      );
    }
    const external = href?.startsWith('https://') || href?.startsWith('http://');
    return (
      <a
        {...props}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer noopener' : undefined}
        onClick={(event) => {
          if (href && onLinkClick) onLinkClick(href, event);
        }}
        className={cn(
          className,
          backref
            ? 'ml-1 inline-flex items-center text-xs text-muted-foreground no-underline hover:text-foreground'
            : 'font-medium text-primary underline decoration-primary/35 underline-offset-2 hover:decoration-primary',
        )}
      >
        {children}
      </a>
    );
  },

  // prose 默认的 pre 不折行，长 URL / 长日志会把布局撑破。
  pre: ({ children }) => {
    const child = React.Children.toArray(children)[0];
    const childProps = React.isValidElement<{ children?: React.ReactNode }>(child) ? child.props : null;
    const childText = childProps ? React.Children.toArray(childProps.children).join('') : '';
    if (React.isValidElement<{ 'data-mermaid'?: boolean; children?: React.ReactNode }>(child)
      && (Boolean(child.props['data-mermaid']) || isMermaidSource(childText))) {
      return <MermaidDiagram chart={childText.replace(/\n$/u, '')} />;
    }
    return (
      <pre className="overflow-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed">
        {children}
      </pre>
    );
  },

  code: ({ children, className }) => {
    const value = String(children).replace(/\n$/u, '');
    const language = className?.match(/language-([a-z0-9_-]+)/iu)?.[1]?.toLowerCase();
    if (language === 'mermaid' || isMermaidSource(value)) {
      return <code data-mermaid>{children}</code>;
    }
    return <code className={className}>{children}</code>;
  },

  // 宽表格需要独立的横向滚动容器，否则会顶破 760px 量度。
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="bg-muted/60 text-left font-semibold">{children}</th>,
};

export default function MarkdownContent({
  content,
  className,
  compact = false,
  onLinkClick,
}: {
  content: string;
  className?: string;
  /** Research/editor surfaces use a denser 15px reading measure. */
  compact?: boolean;
  /** Optional surface-specific link interception; ordinary links remain new-tab links by default. */
  onLinkClick?: MarkdownLinkClickHandler;
}) {
  return (
    <div
      className={cn(
        'prose max-w-none break-words dark:prose-invert',
        compact && 'prose-sm prose-compact',
        // Give research copy a calmer reading rhythm without overriding the
        // compact message treatment used in the chat column.
        !compact && 'prose-p:leading-8 prose-li:leading-7',
        className,
      )}
    >
      <MarkdownLinkClickContext.Provider value={onLinkClick}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex, rehypeHighlight]}
          skipHtml
          urlTransform={transformMarkdownUrl}
          components={components}
        >
          {prepareContent(content)}
        </ReactMarkdown>
      </MarkdownLinkClickContext.Provider>
    </div>
  );
}
