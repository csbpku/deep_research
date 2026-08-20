'use client';

import MarkdownContent from '@/components/MarkdownContent';
import type { RadarGuide } from './RadarAiReadingTab';
import { normalizeRadarQuote, radarBlockId, splitRadarReadingBlocks } from './radar-reading-blocks';

interface RadarAugmentedArticleProps {
  content: string;
  guide: RadarGuide | null;
  onQuoteClick?: (quote: string) => void;
}

type Annotation = {
  claim?: string;
  whyItMatters?: string;
  evidence?: string;
};

function annotationsForBlock(block: string, guide: RadarGuide | null): Annotation[] {
  if (!guide) return [];
  const normalizedBlock = normalizeRadarQuote(block);
  const takeaways = guide.keyTakeaways?.length
    ? guide.keyTakeaways
    : (guide.conclusions ?? []).map((item) => ({ claim: item.claim, evidence: item.evidence }));
  return takeaways.filter((item) => {
    const quote = item.evidence ? normalizeRadarQuote(item.evidence).slice(0, 80) : '';
    return quote.length >= 24 && normalizedBlock.includes(quote);
  }).slice(0, 2);
}

export function RadarAugmentedArticle({ content, guide, onQuoteClick }: RadarAugmentedArticleProps) {
  const blocks = splitRadarReadingBlocks(content);

  return (
    <article className="space-y-0">
      {guide?.summary ? (
        <div className="mb-6 border-l-2 border-[var(--ink-accent)] bg-[var(--ink-accent)]/[0.06] px-3.5 py-3">
          <div className="mb-1 font-sans text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--ink-accent)]">快速理解</div>
          <p className="font-serif text-sm leading-6 text-[var(--ink-text)]">{guide.summary}</p>
        </div>
      ) : null}

      {blocks.map((block, index) => {
        const annotations = annotationsForBlock(block, guide);
        return (
          <section key={radarBlockId(index)} id={`augmented-${radarBlockId(index)}`} className="scroll-mt-6 border-b border-[var(--ink-rule)]/60 py-5 first:pt-0 last:border-b-0">
            <MarkdownContent content={block} className="reading-workbench-markdown font-serif text-[16px] leading-[1.85] text-[var(--ink-text)]" />
            {annotations.length ? (
              <div className="mt-4 space-y-2 border-l-2 border-[var(--ink-accent)]/50 pl-3">
                {annotations.map((item, annotationIndex) => (
                  <div key={`${item.claim ?? 'annotation'}-${annotationIndex}`} className="bg-[var(--ink-accent)]/[0.05] px-3 py-2.5">
                    <div className="mb-1 font-sans text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-accent)]">AI 注释</div>
                    {item.claim ? <p className="font-serif text-sm leading-6 text-[var(--ink-text)]">{item.claim}</p> : null}
                    {item.whyItMatters ? <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">为什么重要：{item.whyItMatters}</p> : null}
                    {item.evidence ? (
                      <button type="button" onClick={() => onQuoteClick?.(item.evidence!)} className="mt-1.5 text-left text-[11px] font-medium text-[var(--ink-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40">
                        查看依据 ↗
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </article>
  );
}
