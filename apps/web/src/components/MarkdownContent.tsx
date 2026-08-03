import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

import { cn } from '@/lib/utils';

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
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),

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
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
