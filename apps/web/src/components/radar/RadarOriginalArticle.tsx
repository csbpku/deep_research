'use client';

import { memo, useEffect, useRef, useState } from 'react';

import MarkdownContent from '@/components/MarkdownContent';
import {
  prepareRadarReadingContent,
  radarBlockId,
  splitRadarReadingBlocks,
} from './radar-reading-blocks';
import { cn } from '@/lib/utils';

interface Highlights {
  summary: string;
  highlights: string[];
  keyQuote: string | null;
}

interface RadarOriginalArticleProps {
  /** 原文 markdown（originalMarkdown ?? body） */
  content: string;
  highlights: Highlights | null;
  /** Remove a source-level title when the page already renders the title. */
  title?: string;
  paperMode?: boolean;
  className?: string;
  annotations?: Array<{ id: string; quote: string }>;
  selectedAnnotationId?: string | null;
  onAnnotationClick?: (annotationId: string) => void;
}

interface RadarTocItem {
  label: string;
  level: 2 | 3;
  blockIndex: number;
}

function extractRadarToc(blocks: string[], paperMode = false): RadarTocItem[] {
  return blocks.flatMap((block, blockIndex) => {
    const heading = block.match(new RegExp(`^(#{${paperMode ? '1,6' : '2,3'}})\\s+(.+?)\\s*#*\\s*$`, 'mu'));
    if (!heading) return [];
    // Trafilatura flattens HTML <details><summary><b>...</b></summary>
    // blocks into bold Markdown headings. They are code-example labels, not
    // article sections, so keep them in the body but exclude them from TOC.
    if (/^(?:\*\*|__)[^*_]+(?:\*\*|__)$/u.test(heading[2]!.trim())) return [];
    const level = heading[1]!.length as 2 | 3;
    const label = heading[2]!
      .replace(/[*_`]/gu, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
      .trim();
    return label ? [{ label, level, blockIndex }] : [];
  });
}

/**
 * 左栏原文 —— 始终可见，serif 排版。
 *
 * 与右栏 AI 面板解耦：右栏 tab 切换不影响这里。原文区域保持干净，
 * AI 导读通过右侧的“回到原文”入口完成定位。
 */
export function highlightAnnotationQuotes(
  root: HTMLElement,
  annotations: Array<{ id: string; quote: string }>,
  options: {
    selectedAnnotationId?: string | null;
    onAnnotationClick?: (annotationId: string) => void;
  } = {},
) {
  root.querySelectorAll<HTMLElement>('.radar-user-annotation').forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
  });
  if (!annotations.length) return;

  const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-radar-block="true"]'));
  for (const annotation of annotations) {
    const target = annotation.quote.trim().replace(/\s+/gu, ' ');
    if (!target) continue;
    for (const block of blocks) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const nodes: Array<{ node: Text; start: number; end: number }> = [];
      let raw = '';
      let current: Node | null;
      while ((current = walker.nextNode())) {
        const node = current as Text;
        const start = raw.length;
        raw += node.data;
        nodes.push({ node, start, end: raw.length });
      }
      const collapsed = raw.replace(/\s+/gu, ' ');
      const index = collapsed.indexOf(target);
      if (index < 0) continue;

      // Map the whitespace-collapsed match back to text-node offsets.
      let collapsedIndex = 0;
      let rawStart = -1;
      let rawEnd = -1;
      let previousWasSpace = false;
      for (let rawIndex = 0; rawIndex < raw.length; rawIndex += 1) {
        const isSpace = /\s/u.test(raw[rawIndex] ?? '');
        if (isSpace && previousWasSpace) continue;
        if (collapsedIndex === index) rawStart = rawIndex;
        if (collapsedIndex === index + target.length - 1) {
          rawEnd = rawIndex + 1;
          break;
        }
        collapsedIndex += 1;
        previousWasSpace = isSpace;
      }
      if (rawStart < 0 || rawEnd < 0) continue;
      const startNode = nodes.find((item) => rawStart >= item.start && rawStart < item.end);
      const endNode = nodes.find((item) => rawEnd > item.start && rawEnd <= item.end);
      if (!startNode || !endNode) continue;

      // Do not use surroundContents here: a quote can cross Markdown inline
      // elements (for example **bold** text + the following word), in which
      // case surroundContents throws and the annotation silently disappears.
      // Wrapping each intersecting text slice keeps the existing DOM intact.
      const overlapping = nodes.filter((item) => item.end > rawStart && item.start < rawEnd).reverse();
      for (const item of overlapping) {
        if (item.node.parentElement?.closest('.radar-user-annotation')) continue;
        const from = Math.max(rawStart, item.start) - item.start;
        const to = Math.min(rawEnd, item.end) - item.start;
        if (to <= from) continue;
        const selected = item.node.splitText(to);
        const prefix = item.node;
        const selectedNode = prefix.splitText(from);
        const mark = document.createElement('mark');
        mark.className = 'radar-user-annotation rounded-sm bg-amber-200/75 px-0.5 text-inherit decoration-amber-500/80 decoration-2 underline-offset-2';
        mark.dataset.annotationId = annotation.id;
        mark.style.cursor = 'pointer';
        if (annotation.id === options.selectedAnnotationId) {
          mark.style.boxShadow = '0 0 0 2px rgb(180 83 9 / 0.55)';
        }
        if (options.onAnnotationClick) {
          mark.setAttribute('role', 'button');
          mark.tabIndex = 0;
          mark.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            options.onAnnotationClick?.(annotation.id);
          });
          mark.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              options.onAnnotationClick?.(annotation.id);
            }
          });
        }
        selectedNode.parentNode?.replaceChild(mark, selectedNode);
        mark.appendChild(selectedNode);
      }
      break;
    }
  }
}

export const RadarOriginalArticle = memo(function RadarOriginalArticle({
  content,
  title,
  paperMode = false,
  className,
  annotations = [],
  selectedAnnotationId,
  onAnnotationClick,
}: RadarOriginalArticleProps) {
  const [tocWidth, setTocWidth] = useState(240);
  const tocResizingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const readingContent = prepareRadarReadingContent(content, title, paperMode);
  const blocks = splitRadarReadingBlocks(readingContent);
  const toc = extractRadarToc(blocks, paperMode);

  useEffect(() => {
    if (!paperMode || !rootRef.current) return;
    rootRef.current.querySelectorAll<HTMLElement>('.katex-display').forEach((equation, index) => {
      const tag = equation.querySelector<HTMLElement>('.tag')?.textContent?.trim()
        || equation.textContent?.match(/\((\d+)\)\s*$/u)?.[1];
      const id = tag ? `radar-equation-${tag.replace(/[^\d]/gu, '')}` : `radar-equation-${index + 1}`;
      equation.id = id;
      equation.setAttribute('aria-label', tag ? `公式 ${tag}` : `公式 ${index + 1}`);
    });
    rootRef.current.querySelectorAll<HTMLImageElement>('img').forEach((image, index) => {
      // currentSrc may omit the fragment from data URLs; src retains the
      // arXiv figure anchor that the article map uses for deep links.
      const sourceAnchor = image.src.match(/#([A-Za-z]\d+\.F\d+)$/u)?.[1];
      if (sourceAnchor) image.id = sourceAnchor;
      else if (!image.id) image.id = `radar-figure-${index + 1}`;
    });
  }, [paperMode, blocks.length, content]);

  useEffect(() => {
    if (rootRef.current) {
      highlightAnnotationQuotes(rootRef.current, annotations, { selectedAnnotationId, onAnnotationClick });
    }
    return () => {
      rootRef.current?.querySelectorAll<HTMLElement>('.radar-user-annotation').forEach((mark) => {
        mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
      });
    };
  }, [annotations, blocks.length, content, onAnnotationClick, selectedAnnotationId]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!tocResizingRef.current || !rootRef.current) return;
      const rootLeft = rootRef.current.getBoundingClientRect().left;
      setTocWidth(Math.min(360, Math.max(180, event.clientX - rootLeft)));
    };
    const stopResizing = () => {
      if (!tocResizingRef.current) return;
      tocResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResizing);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResizing);
    };
  }, []);

  const startTocResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    tocResizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleTocResizeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowLeft') setTocWidth((width) => Math.max(180, width - 16));
    if (event.key === 'ArrowRight') setTocWidth((width) => Math.min(360, width + 16));
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {toc.length ? (
        <details
          className="mb-6 overflow-y-auto overscroll-contain rounded-lg border border-[var(--ink-rule)] bg-[var(--ink-page)] lg:hidden"
          style={{ maxHeight: '60dvh' }}
        >
          <summary className="cursor-pointer px-3 py-2.5 text-xs font-semibold text-[var(--ink-text)]">目录</summary>
          <TocList items={toc} />
        </details>
      ) : null}
      <div
        className={cn(toc.length ? 'lg:grid lg:items-start lg:gap-0' : '')}
        style={toc.length ? { gridTemplateColumns: `${tocWidth}px 28px minmax(0, 1fr)` } : undefined}
      >
        {toc.length ? (
          <nav className="sticky top-4 hidden h-[calc(100dvh-12rem)] max-h-[calc(100dvh-12rem)] self-start overscroll-contain overflow-y-auto pr-2 lg:block" aria-label="原文目录">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-accent)]">On this page</p>
            <TocList items={toc} />
          </nav>
        ) : null}
        {toc.length ? (
          <button
            type="button"
            className="group relative z-20 hidden min-h-[520px] w-3 touch-none cursor-col-resize items-start justify-center self-stretch justify-self-center border-x border-[var(--ink-rule)] bg-[var(--ink-page)] lg:flex"
            aria-label="调整左侧目录栏宽度"
            aria-valuemin={180}
            aria-valuemax={360}
            aria-valuenow={tocWidth}
            role="separator"
            onPointerDown={startTocResize}
            onKeyDown={handleTocResizeKeyDown}
          >
            <span className="sticky top-1/2 mt-8 h-24 w-1 rounded-full bg-[var(--ink-rule)] transition-colors group-hover:bg-[var(--ink-accent)]" />
          </button>
        ) : null}
        <div data-radar-reading-body="true" className="reading-workbench-markdown min-w-0 text-[16px] text-[var(--ink-text)] selection:bg-[var(--ink-accent)]/20 lg:pl-8">
        {blocks.map((block, index) => (
          <section
            key={radarBlockId(index)}
            id={radarBlockId(index)}
            data-radar-block="true"
            data-radar-block-index={index}
            className={cn(
              'group relative scroll-mt-6 rounded-md px-3 py-2 -mx-3 transition-colors',
              // Selection actions are rendered next to the browser text selection.
              // Do not paint the whole paragraph as a second, blue selection state.
            )}
          >
            <MarkdownContent content={block} className="text-[16px] text-[var(--ink-text)]" />
          </section>
        ))}
        </div>
      </div>
    </div>
  );
});

function TocList({ items }: { items: RadarTocItem[] }) {
  return (
    <ol className="space-y-0.5 border-l border-[var(--ink-rule)] pl-3">
      {items.map((item) => (
        <li key={`${item.blockIndex}-${item.label}`}>
          <a
            href={`#${radarBlockId(item.blockIndex)}`}
            className={cn(
              'block py-1 text-xs leading-5 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink-accent)]',
              item.level === 2 && 'font-semibold text-[var(--ink-text)]',
              item.level === 3 && 'pl-2 text-[11px]',
            )}
          >
            {item.label}
          </a>
        </li>
      ))}
    </ol>
  );
}
