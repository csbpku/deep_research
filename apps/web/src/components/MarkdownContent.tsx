import React, { useContext, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import Box from '@mui/material/Box';
import type { SxProps, Theme } from '@mui/material/styles';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import type { Components } from 'react-markdown';
import { ZoomIn } from 'lucide-react';
import { breakpoints } from '@deep-research/design-system';
import MermaidDiagram, { isMermaidSource } from './MermaidDiagram';

import { prepareContent } from '@/lib/markdown-content';
import { compactResearchCitations, type ResearchCitationSource } from '@/lib/research-citations';
import 'katex/dist/katex.min.css';

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
}: React.ComponentPropsWithoutRef<'a'> & {
  label?: string;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const isReference = Boolean(href?.startsWith('#bib') || href?.startsWith('#user-content-fn-'));
  const external = href?.startsWith('https://') || href?.startsWith('http://');

  if (!isReference) {
    return (
      <Box
        component="a"
        {...props}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer noopener' : undefined}
        className={className}
        sx={markdownAnchorSx}
      >
        {children}
      </Box>
    );
  }

  const showPreview = () => {
    const targetId = href?.slice(1);
    const target = targetId ? document.getElementById(targetId) : null;
    setPreview(target?.textContent?.replace(/\s+/gu, ' ').trim().slice(0, 360) || '正文中暂未找到对应参考文献。');
  };

  return (
    <Box component="span" sx={{ position: 'relative', display: 'inline-block' }} onMouseEnter={showPreview} onMouseLeave={() => setPreview(null)}>
      <Box
        component="a"
        {...props}
        href={href}
        className={className}
        sx={markdownAnchorSx}
        aria-label={`${label} ${reactNodeText(children)}`.trim()}
        onFocus={showPreview}
        onBlur={() => setPreview(null)}
      >
        {children}
      </Box>
      {preview ? (
        <Box
          component="span"
          role="tooltip"
          sx={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            zIndex: 1500,
            mb: 'var(--dr-space-2)',
            width: '18rem',
            transform: 'translateX(-50%)',
            border: '1px solid var(--dr-color-outline)',
            borderRadius: 'var(--dr-radius-small)',
            backgroundColor: 'var(--dr-color-inverse-surface)',
            px: 'var(--dr-space-3)',
            py: 'var(--dr-space-2)',
            textAlign: 'left',
            fontSize: 'var(--dr-type-caption)',
            fontWeight: 'var(--dr-weight-regular)',
            lineHeight: 'var(--dr-line-height-body)',
            color: 'var(--dr-color-inverse-text)',
            boxShadow: 'var(--dr-elevation-2)',
          }}
        >
          <Box
            component="span"
            sx={{
              display: 'block',
              mb: 'var(--dr-space-1)',
              fontSize: 'var(--dr-type-caption)',
              fontWeight: 'var(--dr-weight-semibold)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--dr-color-primary)',
            }}
          >
            {label}
          </Box>
          {preview}
        </Box>
      ) : null}
    </Box>
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
 * 排版直接消费共享 design-system token；不维护独立的文章调色板或 Tailwind prose 层。
 * 排版规则由 sx 按语义元素统一定义；这里额外处理少数交互与结构需求：
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

function reactNodeText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return reactNodeText(node.props.children);
  return '';
}

function markdownContentSx(compact: boolean) {
  const blockSpacing = compact ? 'var(--dr-space-3)' : '1.25em';
  const sx: SxProps<Theme> = {
    maxWidth: 'none',
    overflowWrap: 'break-word',
    color: 'var(--dr-color-text-secondary)',
    fontFamily: 'var(--dr-font-family)',
    fontSize: compact ? 'var(--dr-type-body)' : 'var(--dr-type-reading)',
    lineHeight: compact ? 'var(--dr-line-height-body)' : 'var(--dr-line-height-reading)',
    '& > :first-child': { marginTop: 0 },
    '& > :last-child': { marginBottom: 0 },
    '& :is(h1, h2, h3, h4, h5, h6)': {
      color: 'var(--dr-color-text)',
      fontFamily: 'var(--dr-font-family)',
      fontWeight: 'var(--dr-weight-semibold)',
      lineHeight: 'var(--dr-line-height-heading)',
    },
    '& h1': { fontSize: 'var(--dr-type-page-title)', marginBlock: '0 var(--dr-space-4)' },
    '& h2': { fontSize: 'var(--dr-type-title-medium)', marginBlock: '0 var(--dr-space-3)' },
    '& h3': { fontSize: 'var(--dr-type-title-small)', marginBlock: '0 var(--dr-space-2)' },
    '& :is(h4, h5, h6)': { fontSize: 'var(--dr-type-body)', marginBlock: '0 var(--dr-space-2)' },
    '& :is(p, ul, ol)': { marginBlock: blockSpacing },
    '& ul, & ol': { paddingInlineStart: '1.625em' },
    '& li': {
      paddingInlineStart: 'var(--dr-space-1)',
      '&::marker': { color: 'var(--dr-color-text-muted)' },
    },
    '& strong, & b': { color: 'var(--dr-color-text)', fontWeight: 'var(--dr-weight-bold)' },
    '& blockquote': {
      marginBlock: 'var(--dr-space-4)',
      borderLeft: '2px solid var(--dr-color-outline)',
      borderRadius: '0 var(--dr-radius-small) var(--dr-radius-small) 0',
      backgroundColor: 'color-mix(in srgb, var(--dr-color-surface-container) 50%, transparent)',
      paddingBlock: 'var(--dr-space-1)',
      paddingInline: 'var(--dr-space-4) var(--dr-space-3)',
      color: 'var(--dr-color-text-secondary)',
      fontWeight: 'var(--dr-weight-regular)',
      fontStyle: 'normal',
    },
    '& blockquote p::before, & blockquote p::after': { content: 'none' },
    '& code:not(pre code)': {
      borderRadius: 'var(--dr-radius-xs)',
      backgroundColor: 'var(--dr-color-surface-container)',
      padding: '0.125em 0.25em',
      color: 'var(--dr-color-primary)',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: '0.85em',
      fontWeight: 'var(--dr-weight-regular)',
    },
    '& code:not(pre code)::before, & code:not(pre code)::after': { content: 'none' },
    '& pre': {
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      marginBlock: '1.7em',
      borderRadius: 'var(--dr-radius-small)',
      backgroundColor: 'var(--dr-color-surface-container)',
      padding: 'var(--dr-space-3) var(--dr-space-4)',
      color: 'var(--dr-color-text)',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 'var(--dr-type-label)',
      lineHeight: 'var(--dr-line-height-body)',
    },
    '& pre code': {
      display: 'block',
      backgroundColor: 'transparent',
      padding: 0,
      color: 'inherit',
      fontSize: 'inherit',
      lineHeight: 'inherit',
    },
    '& .hljs :is(.hljs-comment, .hljs-quote)': { color: 'var(--dr-color-text-muted)' },
    '& .hljs :is(.hljs-keyword, .hljs-doctag, .hljs-formula)': { color: 'var(--dr-color-inference)' },
    '& .hljs :is(.hljs-title, .hljs-section, .hljs-name, .hljs-selector-tag)': { color: 'var(--dr-color-evidence)' },
    '& .hljs :is(.hljs-string, .hljs-regexp, .hljs-template-tag, .hljs-template-variable)': { color: 'var(--dr-color-success)' },
    '& .hljs :is(.hljs-number, .hljs-literal, .hljs-attr, .hljs-attribute, .hljs-symbol, .hljs-bullet, .hljs-built_in, .hljs-type, .hljs-meta)': { color: 'var(--dr-color-warning)' },
    '& .hljs .hljs-deletion': { color: 'var(--dr-color-danger)', backgroundColor: 'var(--dr-color-danger-container)' },
    '& .hljs .hljs-addition': { color: 'var(--dr-color-success)', backgroundColor: 'var(--dr-color-success-container)' },
    '& .hljs .hljs-emphasis': { fontStyle: 'italic' },
    '& .hljs .hljs-strong': { fontWeight: 'var(--dr-weight-bold)' },
    '& table': {
      width: '100%',
      borderCollapse: 'collapse',
      textAlign: 'left',
      fontSize: 'var(--dr-type-label)',
      lineHeight: 'var(--dr-line-height-body)',
    },
    '& th, & td': {
      borderBottom: '1px solid var(--dr-color-outline)',
      padding: 'var(--dr-space-2) var(--dr-space-3)',
      verticalAlign: 'top',
    },
    '& th': {
      backgroundColor: 'var(--dr-color-surface-container)',
      color: 'var(--dr-color-text)',
      fontWeight: 'var(--dr-weight-semibold)',
    },
    '& p[role="note"]': {
      margin: '0 0 var(--dr-space-4)',
      borderBottom: '1px solid color-mix(in srgb, var(--dr-color-outline) 70%, transparent)',
      paddingBottom: 'var(--dr-space-3)',
      fontSize: 'var(--dr-type-caption)',
      lineHeight: 'var(--dr-line-height-body)',
      color: 'var(--dr-color-text-muted)',
    },
  };
  return sx;
}

const markdownAnchorSx = {
  color: 'var(--dr-color-primary)',
  fontWeight: 'var(--dr-weight-medium)',
  textDecorationLine: 'underline',
  textDecorationColor: 'color-mix(in srgb, var(--dr-color-primary) 35%, transparent)',
  textUnderlineOffset: '2px',
  '&:hover': { textDecorationColor: 'var(--dr-color-primary)' },
  '&:focus-visible': {
    borderRadius: 'var(--dr-radius-xs)',
    outline: '2px solid var(--dr-color-primary)',
    outlineOffset: '2px',
  },
};

const components: Components = {
  // Imported article bodies often contain meaningful single line breaks even
  // when they are not fully-authored Markdown. Preserve those breaks instead
  // of letting the browser collapse the whole body into one dense paragraph.
  // Image-only Markdown is represented as a paragraph containing an image.
  // Our image renderer returns a figure, which cannot legally live inside p.
  p: ({ children, node }) => (
    containsImageNode(node)
      ? <Box sx={{ whiteSpace: 'pre-line' }}>{children}</Box>
      : <Box component="p" sx={{ whiteSpace: 'pre-line' }}>{children}</Box>
  ),
  hr: () => <Box component="hr" sx={{ my: 'var(--dr-space-8)', border: 0, borderTop: '1px solid var(--dr-color-outline)' }} />,
  img: ({ src, alt, title }) => {
    // react-markdown parses `[![alt](img)](url)` so the img component is invoked
    // while rendering the children of an outer link. Without this check the
    // click-to-open wrapper below would produce `<a><a><img/></a></a>` and
    // React would refuse to hydrate the resulting DOM.
    const insideLink = useContext(MarkdownInsideLinkContext);
    const imageSrc = typeof src === 'string' ? src : '';
    if (!imageSrc || !isSafeImageSource(imageSrc)) return null;
    const isSvg = imageSrc.startsWith('data:image/svg+xml');
    const imageSx: SxProps<Theme> = {
      display: 'block',
      mx: 'auto',
      maxHeight: 'min(70vh, 720px)',
      width: 'auto',
      objectFit: 'contain',
      maxWidth: isSvg ? 'none' : '100%',
      ...(isSvg ? { [`@media (min-width:${breakpoints.lg}px)`]: { maxWidth: '100%' } } : {}),
    };
    return (
      <Box
        component="figure"
        sx={{
          my: 'calc(var(--dr-space-6) + var(--dr-space-1))',
          overflow: 'hidden',
          border: '1px solid var(--dr-color-outline)',
          borderRadius: 'var(--dr-radius-medium)',
          backgroundColor: 'var(--dr-color-surface)',
        }}
      >
        <Box sx={isSvg ? { overflowX: 'auto' } : undefined}>
          {insideLink ? (
            <Box
              component="img"
              src={imageSrc}
              alt={alt ?? ''}
              title={title ?? undefined}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              sx={imageSx}
            />
          ) : (
            <Box
              component="a"
              href={imageSrc}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="在新标签页查看原图"
              sx={{
                position: 'relative',
                display: 'block',
                width: 'fit-content',
                maxWidth: '100%',
                mx: 'auto',
                color: 'inherit',
                textDecoration: 'none',
                '&:hover > span, &:focus-visible > span': { opacity: 1 },
                '&:focus-visible': {
                  outline: '2px solid var(--dr-color-primary)',
                  outlineOffset: '2px',
                  borderRadius: 'var(--dr-radius-small)',
                },
              }}
            >
              <Box
                component="img"
                src={imageSrc}
                alt={alt ?? ''}
                title={title ?? undefined}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                sx={imageSx}
              />
              <Box
                component="span"
                sx={{
                  pointerEvents: 'none',
                  position: 'absolute',
                  top: 'var(--dr-space-2)',
                  right: 'var(--dr-space-2)',
                  display: 'grid',
                  width: 'var(--dr-space-8)',
                  height: 'var(--dr-space-8)',
                  placeItems: 'center',
                  borderRadius: 'var(--dr-radius-small)',
                  backgroundColor: 'var(--dr-color-scrim)',
                  color: 'var(--dr-color-inverse-text)',
                  opacity: 0,
                  boxShadow: 'var(--dr-elevation-1)',
                  transition: 'opacity var(--dr-motion-fast)',
                  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                }}
              >
                <ZoomIn size={16} aria-hidden="true" />
                <Box
                  component="span"
                  sx={{
                    position: 'absolute',
                    width: '1px',
                    height: '1px',
                    padding: 0,
                    margin: '-1px',
                    overflow: 'hidden',
                    clip: 'rect(0, 0, 0, 0)',
                    whiteSpace: 'nowrap',
                    border: 0,
                  }}
                >
                  在新标签页查看原图
                </Box>
              </Box>
            </Box>
          )}
        </Box>
        {alt ? (
          <Box
            component="figcaption"
            sx={{
              borderTop: '1px solid var(--dr-color-outline)',
              px: 'var(--dr-space-4)',
              py: 'var(--dr-space-2)',
              textAlign: 'center',
              fontSize: 'var(--dr-type-caption)',
              lineHeight: 'var(--dr-line-height-body)',
              color: 'var(--dr-color-text-muted)',
            }}
          >
            {alt}
          </Box>
        ) : null}
      </Box>
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
          className={className}
        >
          {children}
        </ReferenceLink>
      );
    }
    const external = href?.startsWith('https://') || href?.startsWith('http://');
    const linkSx = backref
      ? {
        ml: 'var(--dr-space-1)',
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: 'var(--dr-type-caption)',
        color: 'var(--dr-color-text-muted)',
        textDecoration: 'none',
        '&:hover': { color: 'var(--dr-color-text)' },
      }
      : markdownAnchorSx;
    return (
      <MarkdownInsideLinkContext.Provider value={true}>
        <Box
          component="a"
          {...props}
          href={href}
          target={external ? '_blank' : undefined}
          rel={external ? 'noreferrer noopener' : undefined}
          onClick={(event) => {
            if (href && onLinkClick) onLinkClick(href, event);
          }}
          className={className}
          sx={linkSx}
        >
          {children}
        </Box>
      </MarkdownInsideLinkContext.Provider>
    );
  },

  // Citation markers point to a stable list item in the reader-facing
  // bibliography. The marker is intentionally part of the Markdown text so
  // the same target remains keyboard and screen-reader navigable.
  li: ({ children, node, ...props }) => {
    void node;
    const marker = /^\s*\[(\d+)\](?:\s|$)/u.exec(reactNodeText(children));
    return <Box component="li" {...props} id={marker ? `bib-${marker[1]}` : undefined}>{children}</Box>;
  },

  // Long URLs and logs should wrap instead of expanding the reading column.
  pre: ({ children }) => {
    const child = React.Children.toArray(children)[0];
    const childProps = React.isValidElement<{ children?: React.ReactNode }>(child) ? child.props : null;
    const childText = childProps ? React.Children.toArray(childProps.children).join('') : '';
    if (React.isValidElement<{ 'data-mermaid'?: boolean; children?: React.ReactNode }>(child)
      && (Boolean(child.props['data-mermaid']) || isMermaidSource(childText))) {
      return <MermaidDiagram chart={childText.replace(/\n$/u, '')} />;
    }
    return <Box component="pre">{children}</Box>;
  },

  code: ({ children, className }) => {
    const value = String(children).replace(/\n$/u, '');
    const language = className?.match(/language-([a-z0-9_-]+)/iu)?.[1]?.toLowerCase();
    if (language === 'mermaid' || isMermaidSource(value)) {
      return <Box component="code" data-mermaid>{children}</Box>;
    }
    return <Box component="code" className={className}>{children}</Box>;
  },

  // 宽表格需要独立的横向滚动容器，否则会顶破 760px 量度。
  table: ({ children }) => (
    <Box sx={{ my: 'var(--dr-space-3)', overflowX: 'auto' }} role="region" aria-label="可横向滚动的表格" tabIndex={0}>
      <Box component="p" role="note" sx={{ whiteSpace: 'nowrap' }}>表格可左右滑动查看</Box>
      <table>{children}</table>
    </Box>
  ),
  th: ({ children }) => <Box component="th">{children}</Box>,
};

export default function MarkdownContent({
  content,
  sx,
  compact = false,
  onLinkClick,
  compactCitations = false,
  citationSources = [],
}: {
  content: string;
  sx?: SxProps<Theme>;
  /** Research/editor surfaces use a denser 15px reading measure. */
  compact?: boolean;
  /** Optional surface-specific link interception; ordinary links remain new-tab links by default. */
  onLinkClick?: MarkdownLinkClickHandler;
  /** Compact source-backed external links into reader-facing bibliography markers. */
  compactCitations?: boolean;
  citationSources?: readonly ResearchCitationSource[];
}) {
  const displayContent = compactCitations
    ? compactResearchCitations(content, citationSources)
    : content;

  return (
    <Box
      sx={[
        markdownContentSx(compact),
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
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
          {prepareContent(displayContent)}
        </ReactMarkdown>
      </MarkdownLinkClickContext.Provider>
    </Box>
  );
}
