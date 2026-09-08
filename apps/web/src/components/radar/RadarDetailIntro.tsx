import React from 'react';
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { RadarContentLabel, SourceLabel } from '@/lib/radar/source-labels';

interface RadarDetailIntroProps {
  title: string;
  discoverySource: SourceLabel;
  contentKind: RadarContentLabel;
  summary: string | null;
  authorsLabel?: string | null;
  dateLabel?: string | null;
  coverageLabel?: string | null;
  coverageTone?: 'good' | 'partial';
  sourceName?: string | null;
}

/**
 * One decision-oriented introduction for every radar source.
 *
 * The reader should be able to answer "what is this, why should I care, and
 * how complete is it?" before entering a long source document.
 */
export function RadarDetailIntro({
  title,
  discoverySource,
  contentKind,
  summary,
  authorsLabel,
  dateLabel,
  coverageLabel,
  coverageTone = 'good',
  sourceName,
}: RadarDetailIntroProps) {
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const canExpandSummary = Boolean(summary && summary.length > 120);

  return (
    <header data-testid="radar-detail-intro" className="mb-6 border-b border-[var(--ink-rule)] pb-5 sm:mb-8 sm:pb-7">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--ink-muted)] sm:mb-4">
        <span className="min-w-0 break-words" title={discoverySource.full}>
          发现自：{sourceName?.trim() || discoverySource.short}
        </span>
        <span aria-hidden className="hidden shrink-0 sm:inline">·</span>
        <span className="min-w-0 break-words" title={contentKind.full}>
          内容形态：{contentKind.short}
        </span>
        {dateLabel ? (
          <>
            <span aria-hidden className="hidden shrink-0 sm:inline">·</span>
            <span className="min-w-0 break-words">{dateLabel}</span>
          </>
        ) : null}
      </div>

      <h1 className="break-words font-serif text-2xl font-semibold leading-tight tracking-normal [overflow-wrap:anywhere] sm:text-3xl">
        {title}
      </h1>

      {summary ? (
        <div className="mt-4 max-w-4xl border-l-2 border-[var(--ink-accent)] bg-[var(--ink-accent)]/[0.06] px-3 py-2.5 sm:mt-5 sm:px-4 sm:py-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-accent)]">快速判断</p>
          <p
            id="radar-detail-summary"
            className={summaryExpanded ? 'font-serif text-[14px] leading-6 text-[var(--ink-text)] sm:text-[15px] sm:leading-7' : 'line-clamp-4 font-serif text-[14px] leading-6 text-[var(--ink-text)] sm:line-clamp-none sm:text-[15px] sm:leading-7'}
          >
            {summary}
          </p>
          {canExpandSummary ? (
            <button
              type="button"
              aria-controls="radar-detail-summary"
              aria-expanded={summaryExpanded}
              onClick={() => setSummaryExpanded((expanded) => !expanded)}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--ink-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40 sm:hidden"
            >
              {summaryExpanded ? '收起判断' : '展开完整判断'}
              <ChevronDown className={`size-3.5 transition-transform ${summaryExpanded ? 'rotate-180' : ''}`} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}

      {authorsLabel ? (
        <>
          <p className="mt-3 hidden break-words text-xs leading-5 text-[var(--ink-muted)] sm:block">{authorsLabel}</p>
          <details className="group mt-3 text-xs text-[var(--ink-muted)] sm:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium text-[var(--ink-text)] [&::-webkit-details-marker]:hidden">
              <span>论文信息</span>
              <ChevronDown className="size-3.5 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <p className="mt-2 break-words leading-5">{authorsLabel}</p>
          </details>
        </>
      ) : null}

      {coverageLabel ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--ink-muted)]">
          <span className={coverageTone === 'partial' ? 'font-medium text-status-partial-fg' : 'font-medium text-status-succeeded-fg'}>
            {coverageLabel}
          </span>
        </div>
      ) : null}
    </header>
  );
}
