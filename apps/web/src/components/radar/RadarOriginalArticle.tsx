'use client';

import { useEffect, useRef, useState } from 'react';

import MarkdownContent from '@/components/MarkdownContent';
import { radarBlockId, splitRadarReadingBlocks } from './radar-reading-blocks';
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
}

function removeDuplicateTitle(content: string, title?: string): string {
  if (!title) return content;
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return content;
  const heading = lines[first]!.match(/^#{1,6}\s+(.+?)\s*#*\s*$/u)?.[1]?.trim();
  if (heading !== title.trim()) return content;
  return lines.slice(first + 1).join('\n').trimStart();
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
export function RadarOriginalArticle({ content, title, paperMode = false, className }: RadarOriginalArticleProps) {
  const [tocWidth, setTocWidth] = useState(240);
  const tocResizingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const readingContent = removeDuplicateTitle(content, title);
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
      if (!image.id) image.id = `radar-figure-${index + 1}`;
    });
  }, [paperMode, blocks.length, content]);

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
        <details className="mb-6 rounded-lg border border-[var(--ink-rule)] bg-[var(--ink-page)] lg:hidden">
          <summary className="cursor-pointer px-3 py-2.5 text-xs font-semibold text-[var(--ink-text)]">目录</summary>
          <TocList items={toc} />
        </details>
      ) : null}
      <div
        className={cn(toc.length ? 'lg:grid lg:items-start lg:gap-0' : '')}
        style={toc.length ? { gridTemplateColumns: `${tocWidth}px 28px minmax(0, 1fr)` } : undefined}
      >
        {toc.length ? (
          <nav className="sticky top-5 hidden max-h-[calc(100vh-5rem)] self-start overflow-y-auto lg:block" aria-label="原文目录">
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
        <div className="reading-workbench-markdown min-w-0 text-[16px] text-[var(--ink-text)] selection:bg-[var(--ink-accent)]/20">
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
}

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
