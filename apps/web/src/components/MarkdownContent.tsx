import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import type { Components } from 'react-markdown';

import { cn } from '@/lib/utils';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';

const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

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
  const normalizeMath = (formula: string): string => formula
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
    /\$\$([\s\S]*?)\$\$\s*\n{1,3}\s*\((\d+)\)(?=\s*(?:\n|$))/gu,
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
const components: Components = {
  // Imported article bodies often contain meaningful single line breaks even
  // when they are not fully-authored Markdown. Preserve those breaks instead
  // of letting the browser collapse the whole body into one dense paragraph.
  p: ({ children }) => <p className="whitespace-pre-line">{children}</p>,
  hr: () => <hr className="my-8 border-[var(--ink-rule)]" />,
  img: ({ src, alt, title }) => {
    const imageSrc = typeof src === 'string' ? src : '';
    if (!imageSrc || !/^https?:\/\//iu.test(imageSrc)) return null;
    return (
      <figure className="my-7 overflow-hidden rounded-xl border border-[var(--ink-rule)] bg-[var(--ink-page)]">
        <img
          src={imageSrc}
          alt={alt ?? ''}
          title={title ?? undefined}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="mx-auto max-h-[min(70vh,720px)] w-auto max-w-full object-contain"
        />
        {alt ? <figcaption className="border-t border-[var(--ink-rule)] px-4 py-2 text-center text-xs leading-5 text-muted-foreground">{alt}</figcaption> : null}
      </figure>
    );
  },
  a: ({ href, children, node, className, ...props }) => {
    void node;
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
  pre: ({ children }) => (
    <pre className="overflow-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed">
      {children}
    </pre>
  ),

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
}: {
  content: string;
  className?: string;
  /** Research/editor surfaces use a denser 15px reading measure. */
  compact?: boolean;
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
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        skipHtml
        urlTransform={safeMarkdownUrl}
        components={components}
      >
        {prepareContent(content)}
      </ReactMarkdown>
    </div>
  );
}
