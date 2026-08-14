'use client';

import { useMemo, useState } from 'react';

import MarkdownContent from '@/components/MarkdownContent';
import { Marginalia, type MarginaliaAnchor } from './Marginalia';
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
  className?: string;
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

/**
 * 左栏原文 —— 始终可见，serif 排版。
 *
 * 与右栏 AI 面板解耦：右栏 tab 切换不影响这里。Marginalia ↗ 角标由
 * AI导读的 highlights.keyQuote 匹配原文段落生成。
 */
export function RadarOriginalArticle({ content, highlights, className }: RadarOriginalArticleProps) {
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);

  const anchors = useMemo<MarginaliaAnchor[]>(() => {
    const keyQuote = highlights?.keyQuote;
    if (!keyQuote) return [];
    const needle = normalize(keyQuote);
    if (!needle) return [];
    const blocks = content.split(/\n{2,}/u).map((b) => b.trim()).filter(Boolean);
    const matches: MarginaliaAnchor[] = [];
    blocks.forEach((block, index) => {
      if (normalize(block).includes(needle)) {
        matches.push({
          anchorId: `anchor-${index}`,
          top: 0, // M4 由父组件测量真实 offset 后重算；这里先占位
          order: matches.length + 1,
        });
      }
    });
    return matches;
  }, [content, highlights?.keyQuote]);

  const handleAnchorClick = (anchorId: string) => {
    setActiveAnchorId(anchorId);
    const el = document.getElementById(anchorId);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className={cn('relative', className)}>
      <Marginalia anchors={anchors} activeAnchorId={activeAnchorId} onAnchorClick={handleAnchorClick} />
      <MarkdownContent
        content={content}
        className="reading-workbench-markdown font-serif text-[16px] leading-[1.75] text-[var(--ink-text)]"
      />
    </div>
  );
}
