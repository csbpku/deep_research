'use client';

import { useEffect, useRef } from 'react';
import React from 'react';
import Box from '@mui/material/Box';
import type { SxProps, Theme } from '@mui/material/styles';

import MarkdownContent from './MarkdownContent';
import { compactResearchCitations, type ResearchCitationSource } from '@/lib/research-citations';

interface TextSelection {
  quote: string;
  startOffset: number;
  endOffset: number;
}

interface Props {
  source: string;
  onTextSelect?: (selection: TextSelection | null) => void;
  sx?: SxProps<Theme>;
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
export function MarkdownPreview({ source, onTextSelect, sx, compactCitations = false, citationSources = [] }: Props) {
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
    <Box
      ref={ref}
      sx={[
        {
          maxHeight: '400px',
          overflowY: 'auto',
          border: '1px solid var(--dr-color-outline)',
          borderRadius: 'var(--dr-radius-small)',
          backgroundColor: 'var(--dr-color-surface)',
          p: 'var(--dr-space-4)',
          fontSize: 'var(--dr-type-label)',
          lineHeight: 'var(--dr-line-height-body)',
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {compactCitations && displaySource !== source ? (
        <Box
          component="p"
          role="note"
          sx={{
            mb: 'var(--dr-space-4)',
            borderBottom: '1px solid color-mix(in srgb, var(--dr-color-outline) 70%, transparent)',
            pb: 'var(--dr-space-3)',
            fontSize: 'var(--dr-type-caption)',
            lineHeight: 'var(--dr-line-height-body)',
            color: 'var(--dr-color-text-muted)',
          }}
        >
          正文引用已折叠为编号；点击编号可跳到文末参考文献，悬停或聚焦可预览来源。
        </Box>
      ) : null}
      <MarkdownContent content={displaySource} compact />
    </Box>
  );
}
