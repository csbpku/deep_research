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
import { prepareContent } from '@/lib/markdown-content';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';

export { prepareContent } from '@/lib/markdown-content';

const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export type MarkdownLinkClickHandler = (
  href: string,
  event: React.MouseEvent<HTMLAnchorElement>,
) => void;

const MarkdownLinkClickContext = React.createContext<MarkdownLinkClickHandler | undefined>(undefined);
const MarkdownInsideLinkContext = React.createContext<boolean>(false);

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
    // react-markdown parses `[![alt](img)](url)` so the img component is invoked
    // while rendering the children of an outer link. Without this check the
    // click-to-open wrapper below would produce `<a><a><img/></a></a>` and
    // React would refuse to hydrate the resulting DOM.
    const insideLink = useContext(MarkdownInsideLinkContext);
    const imageSrc = typeof src === 'string' ? src : '';
    if (!imageSrc || !isSafeImageSource(imageSrc)) return null;
    const isSvg = imageSrc.startsWith('data:image/svg+xml');
    return (
      <figure className="my-7 overflow-hidden rounded-xl border border-[var(--ink-rule)] bg-[var(--ink-page)]">
        <div className={cn(isSvg && 'overflow-x-auto')}>
          {insideLink ? (
            <img
              src={imageSrc}
              alt={alt ?? ''}
              title={title ?? undefined}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className={cn(
                'mx-auto max-h-[min(70vh,720px)] w-auto object-contain',
                isSvg ? 'max-w-none lg:max-w-full' : 'max-w-full',
              )}
            />
          ) : (
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
                  isSvg ? 'max-w-none lg:max-w-full' : 'max-w-full',
                )}
              />
              <span className="pointer-events-none absolute right-2 top-2 grid size-8 place-items-center rounded-md bg-black/55 text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <ZoomIn className="size-4" aria-hidden="true" />
                <span className="sr-only">在新标签页查看原图</span>
              </span>
            </a>
          )}
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
      <MarkdownInsideLinkContext.Provider value={true}>
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
      </MarkdownInsideLinkContext.Provider>
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
    <div className="my-3 overflow-x-auto" role="region" aria-label="可横向滚动的表格" tabIndex={0}>
      <p className="mb-1 whitespace-nowrap text-[11px] text-muted-foreground">表格可左右滑动查看</p>
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
          rehypePlugins={[
            // Keep one canonical visual math tree. KaTeX's default
            // html+MathML output is useful for accessibility, but its hidden
            // MathML annotation can become visible duplicate text inside
            // extracted arXiv table cells when the surrounding CSS is reset.
            [rehypeKatex, { output: 'html', strict: 'ignore' }],
            rehypeHighlight,
          ]}
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
