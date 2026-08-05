import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

import { cn } from '@/lib/utils';

/**
 * Source extraction frequently returns hard-wrapped plain text rather than
 * authored Markdown (especially PDF/arXiv). ReactMarkdown cannot infer
 * paragraphs from those wraps, so reflow that narrow case into readable
 * paragraphs while leaving real Markdown untouched.
 */
function prepareContent(content: string): string {
  let source = content.replace(/\r\n?/g, '\n').trim();
  if (!source) return '';

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

  const hasMarkdownStructure = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|>\s|```|\|.+\|)/m.test(source);
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
 * MarkdownContent —— 已发布正文的渲染器（调研库详情、雷达详情、日报等）。
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
  a: ({ href, children, node, className, ...props }) => {
    void node;
    const external = href?.startsWith('https://') || href?.startsWith('http://');
    const backref = 'data-footnote-backref' in props;
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {prepareContent(content)}
      </ReactMarkdown>
    </div>
  );
}
