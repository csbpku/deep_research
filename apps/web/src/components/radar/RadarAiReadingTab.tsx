'use client';

import { useMemo, useState } from 'react';

export interface RadarGuide {
  version?: 2 | 4;
  summary?: string;
  outline?: Array<{
    heading?: string;
    takeaway?: string;
    quote?: string;
    sourceBlockIndex?: number;
    sourceBlockId?: string;
    anchorStatus?: 'resolved' | 'unresolved';
  }>;
  keyTakeaways?: Array<{ claim?: string; whyItMatters?: string; evidence?: string }>;
  implications?: string[];
  caveats?: string[];
  openQuestions?: string[];
  highlights?: Array<{ quote?: string; rationale?: string }>;
  // Legacy fields are accepted so already-cached guides remain renderable.
  conclusions?: Array<{ claim?: string; evidence?: string }>;
  limitations?: string[];
}

interface RadarAiReadingTabProps {
  guide: RadarGuide;
  onHighlightClick?: (quote: string, sourceBlockIndex?: number, total?: number) => void;
}

type RadarTakeaway = { claim?: string; whyItMatters?: string; evidence?: string };

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 mt-7 border-b border-[var(--ink-rule)] pb-2 font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)] first:mt-0">
      {children}
    </h3>
  );
}

function CollapsibleSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <details className="group border-b border-[var(--ink-rule)] py-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-sans text-xs font-semibold text-[var(--ink-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40 [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <span className="text-[var(--ink-faint)] transition-transform group-open:rotate-180">⌄</span>
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}

/** Progressive, source-grounded AI reading brief. */
export function RadarAiReadingTab({ guide, onHighlightClick }: RadarAiReadingTabProps) {
  const [showAllTakeaways, setShowAllTakeaways] = useState(false);
  const takeaways = useMemo<RadarTakeaway[]>(
    () => guide.keyTakeaways?.length
      ? guide.keyTakeaways
      : (guide.conclusions ?? []).map((item) => ({ claim: item.claim, evidence: item.evidence })),
    [guide.conclusions, guide.keyTakeaways],
  );
  const caveats = guide.caveats?.length ? guide.caveats : guide.limitations ?? [];
  const visibleTakeaways = showAllTakeaways ? takeaways : takeaways.slice(0, 3);

  return (
    <div className="space-y-1">
      {guide.summary ? (
        <section aria-labelledby="radar-guide-summary" className="rounded-xl border border-[var(--ink-accent)]/20 bg-[var(--ink-accent)]/[0.07] px-4 py-4">
          <h3 id="radar-guide-summary" className="mb-2 font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-accent)]">一句话判断</h3>
          <p className="font-serif text-[15px] leading-7 text-[var(--ink-text)]">{guide.summary}</p>
        </section>
      ) : null}

      {guide.outline?.length ? (
        <section aria-labelledby="radar-guide-outline">
          <SectionHeading>文章地图</SectionHeading>
          <div id="radar-guide-outline" className="space-y-1.5">
            {guide.outline.map((item, i) => (
              <div
                key={`${item.heading ?? 'section'}-${i}`}
                className="flex gap-3 rounded-lg border border-[var(--ink-rule)] bg-white px-3 py-2.5 transition-colors hover:bg-[var(--ink-accent)]/[0.05]"
              >
                <span className="mt-0.5 font-mono text-[11px] text-[var(--ink-accent)]">{String(i + 1).padStart(2, '0')}</span>
                <div className="min-w-0">
                  <div className="font-sans text-xs font-semibold text-[var(--ink-text)]">{item.heading || `部分 ${i + 1}`}</div>
                  {item.takeaway ? <p className="mt-1 font-serif text-xs leading-5 text-[var(--ink-muted)]">{item.takeaway}</p> : null}
                  {item.quote ? (
                    <button type="button" onClick={() => onHighlightClick?.(item.quote!, item.sourceBlockIndex, guide.outline?.length)} className="mt-1 text-[11px] text-[var(--ink-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40">
                      查看原文 ↗
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {takeaways.length ? (
        <section aria-labelledby="radar-guide-takeaways">
          <SectionHeading>关键观点</SectionHeading>
          <div id="radar-guide-takeaways" className="space-y-2">
            {visibleTakeaways.map((item, i) => (
              <article key={`${item.claim ?? 'takeaway'}-${i}`} className="rounded-lg border border-[var(--ink-rule)] bg-white px-3.5 py-3">
                <div className="flex gap-2">
                  <span className="mt-0.5 shrink-0 font-mono text-[11px] text-[var(--ink-accent)]">{String(i + 1).padStart(2, '0')}</span>
                  <div className="min-w-0">
                    <p className="font-serif text-sm leading-6 text-[var(--ink-text)]">{item.claim || '未提供明确观点。'}</p>
                    {item.whyItMatters ? <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">为什么重要：{item.whyItMatters}</p> : null}
                  </div>
                </div>
                {item.evidence ? (
                  <button type="button" onClick={() => onHighlightClick?.(item.evidence!)} className="mt-2 ml-6 block w-[calc(100%-1.5rem)] border-l-2 border-[var(--ink-accent)]/60 bg-[var(--ink-page)] px-3 py-2 text-left text-[13px] leading-5 text-[var(--ink-muted)] hover:text-[var(--ink-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40">
                    <span className="mb-0.5 block font-sans text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-faint)]">原文证据 · 点击回链</span>
                    {item.evidence}
                  </button>
                ) : null}
              </article>
            ))}
          </div>
          {takeaways.length > 3 ? (
            <button type="button" onClick={() => setShowAllTakeaways((value) => !value)} className="mt-2 text-xs font-medium text-[var(--ink-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40">
              {showAllTakeaways ? '收起其他观点' : `查看全部 ${takeaways.length} 条观点`}
            </button>
          ) : null}
        </section>
      ) : null}

      {guide.implications?.length ? (
        <section>
          <SectionHeading>可能的应用影响</SectionHeading>
          <ul className="rounded-lg border border-emerald-200/80 bg-emerald-50/60 px-4 py-3 font-serif text-sm leading-6 text-[var(--ink-muted)]">
            {guide.implications.map((item, i) => <li key={`${item}-${i}`} className="mb-1.5 last:mb-0 pl-1 marker:text-emerald-600">{item}</li>)}
          </ul>
        </section>
      ) : null}

      <div className="mt-6 border-t border-[var(--ink-rule)] pt-2">
        <CollapsibleSection title="风险与限制" count={caveats.length}>
          <ul className="rounded-lg border border-amber-200/80 bg-amber-50/70 px-4 py-3 font-serif text-sm leading-6 text-[var(--ink-muted)]">
            {caveats.map((item, i) => <li key={`${item}-${i}`} className="mb-1.5 last:mb-0 pl-1 marker:text-amber-600">{item}</li>)}
          </ul>
        </CollapsibleSection>
        <CollapsibleSection title="待验证问题" count={guide.openQuestions?.length ?? 0}>
          <ul className="rounded-lg border border-sky-200/80 bg-sky-50/60 px-4 py-3 font-serif text-sm leading-6 text-[var(--ink-muted)]">
            {guide.openQuestions?.map((item, i) => <li key={`${item}-${i}`} className="mb-1.5 last:mb-0 pl-1 marker:text-sky-600">{item}</li>)}
          </ul>
        </CollapsibleSection>
        <CollapsibleSection title="值得回看的原文摘录" count={guide.highlights?.length ?? 0}>
          <div className="space-y-2">
            {guide.highlights?.map((item, i) => (
              <button key={`${item.quote ?? 'quote'}-${i}`} type="button" onClick={() => onHighlightClick?.(item.quote ?? '')} className="block w-full border-l-2 border-[var(--ink-accent)] bg-white px-3.5 py-3 text-left font-serif text-[13px] leading-6 text-[var(--ink-muted)] hover:bg-[var(--ink-paper)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40">
                <span className="mb-1 block font-sans text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-accent)]">原文摘录 · {i + 1}</span>
                <span className="font-semibold text-[var(--ink-text)]">{item.quote}</span>
                {item.rationale ? <span className="mt-0.5 block text-xs text-[var(--ink-faint)]">{item.rationale}</span> : null}
              </button>
            ))}
          </div>
        </CollapsibleSection>
      </div>
    </div>
  );
}
