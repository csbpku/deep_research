'use client';

import { useEffect, useRef } from 'react';
import React from 'react';

import MarkdownContent from './MarkdownContent';
import { cn } from '@/lib/utils';
import { compactResearchCitations, type ResearchCitationSource } from '@/lib/research-citations';

interface TextSelection {
  quote: string;
  startOffset: number;
  endOffset: number;
}

interface Props {
  source: string;
  onTextSelect?: (selection: TextSelection | null) => void;
  className?: string;
  compactCitations?: boolean;
  citationSources?: readonly ResearchCitationSource[];
}

/**
 * Import/result preview wrapper.
 *
 * Rendering is intentionally delegated to MarkdownContent so imported files,
 * saved research and AI results share the same GFM and URL safety rules.
 * The wrapper only owns the bounded preview surface and optional selection
 * reporting used by future citation/annotation flows.
 */
export function MarkdownPreview({ source, onTextSelect, className, compactCitations = false, citationSources = [] }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const displaySource = compactCitations ? compactResearchCitations(source, citationSources) : source;

  useEffect(() => {
    if (!onTextSelect) return;
    const reportSelection = onTextSelect;
    const element = ref.current;
    if (!element) return;

    function handleMouseUp() {
      const selection = window.getSelection();
      if (
        !selection
        || selection.isCollapsed
        || !selection.rangeCount
        || !element?.contains(selection.anchorNode)
      ) {
        reportSelection(null);
        return;
      }

      const quote = selection.toString().trim();
      if (!quote) {
        reportSelection(null);
        return;
      }

      const startOffset = source.indexOf(quote);
      reportSelection({
        quote,
        startOffset: startOffset >= 0 ? startOffset : 0,
        endOffset: startOffset >= 0 ? startOffset + quote.length : quote.length,
      });
    }

    element.addEventListener('mouseup', handleMouseUp);
    return () => element.removeEventListener('mouseup', handleMouseUp);
  }, [onTextSelect, source]);

  return (
    <div
      ref={ref}
      className={cn(
        'max-h-[400px] overflow-y-auto rounded-lg border border-border bg-card p-4 text-[13px] leading-relaxed',
        className,
      )}
    >
      {compactCitations && displaySource !== source ? (
        <p role="note" className="mb-4 border-b border-border/70 pb-3 text-[11px] leading-5 text-muted-foreground">
          正文引用已折叠为编号；点击编号可跳到文末参考文献，悬停或聚焦可预览来源。
        </p>
      ) : null}
      <MarkdownContent content={displaySource} compact />
    </div>
  );
}
