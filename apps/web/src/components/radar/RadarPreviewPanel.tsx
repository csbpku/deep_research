'use client';

import Link from 'next/link';
import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronDown, ExternalLink, Github, Sparkles, X } from 'lucide-react';

import { DistilledScorePanel } from './DistilledScorePanel';
import {
  cleanRadarTags,
  externalReaderUrl,
  formatRadarDetailDate,
  radarSummaryParts,
  ReaderSourcePrompt,
  type ExternalReadingDetail,
} from './RadarExternalReadingLanding';
import { formatRadarContentKind, formatSourceType } from '@/lib/radar/source-labels';
import { TIER_LABELS, tierClasses } from '@/components/domain/ScoreBar';
import { cn } from '@/lib/utils';
import { zreadRepositoryUrl } from './radar-repository';

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function RadarPreviewPanel({
  detail,
  onClose,
}: {
  detail: ExternalReadingDetail;
  onClose: () => void;
}) {
  const [platformOrigin, setPlatformOrigin] = useState<string | null>(null);
  const [sourcePromptOpen, setSourcePromptOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPlatformOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [detail.id]);

  const sourceLabel = formatSourceType(detail.sourceType);
  const sourceName = detail.sourceName?.trim() || sourceLabel.short;
  const contentLabel = formatRadarContentKind(detail.originalKind, detail.sourceType, detail.url);
  const publishedLabel = formatRadarDetailDate(detail.publishedAt);
  const { lead, supportingExcerpt } = radarSummaryParts(detail);
  const tier = detail.tier ?? detail.distilledScore?.tier ?? null;
  const tierLabel = tier ? (TIER_LABELS[tier] ?? tier) : '待判断';
  const tierVisual = tierClasses(tier ?? 'collection');
  const tags = cleanRadarTags(detail.tags);
  const sourceUrlAvailable = isHttpUrl(detail.url);
  const zreadUrl = detail.originalKind === 'github_repo'
    ? zreadRepositoryUrl(detail.url)
    : null;
  const readerUrl = externalReaderUrl(detail.url, detail.id, platformOrigin);
  const openSource = () => {
    setSourcePromptOpen(false);
    window.open(readerUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <aside
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border border-[var(--ink-rule)] bg-[var(--ink-page)] font-sans shadow-sm lg:max-h-[calc(100dvh-8rem)]"
      aria-label="雷达详情预览"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--ink-rule)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-[9px] font-extrabold uppercase tracking-[0.12em] text-[var(--ink-accent)]">
          <Sparkles className="size-3 shrink-0" aria-hidden />
          <span>快速预览</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex size-7 shrink-0 items-center justify-center text-[var(--ink-muted)] transition-colors hover:bg-[var(--ink-surface)] hover:text-[var(--ink-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40"
          aria-label="关闭预览"
          title="关闭预览"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <div ref={scrollContainerRef} className="min-h-0 overflow-y-auto px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-semibold text-[var(--ink-muted)]">
          <span>{sourceName}</span>
          <span aria-hidden className="text-[var(--ink-faint)]">·</span>
          <span>{contentLabel.short}</span>
          {publishedLabel ? (
            <>
              <span aria-hidden className="text-[var(--ink-faint)]">·</span>
              <span>{publishedLabel}</span>
            </>
          ) : null}
        </div>

        <h2 className="mt-3 break-words font-serif text-xl font-semibold leading-[1.15] text-[var(--ink-text)] [overflow-wrap:anywhere]">
          {detail.title}
        </h2>

        <section className="mt-5 border-l-2 border-[var(--ink-accent)] pl-3" aria-labelledby="radar-preview-summary">
          <p id="radar-preview-summary" className="text-[9px] font-extrabold uppercase tracking-[0.12em] text-[var(--ink-accent)]">
            AI 摘要
          </p>
          <p className="mt-2 whitespace-pre-line font-serif text-[13px] leading-[1.55] text-[var(--ink-text)]">{lead}</p>
          {supportingExcerpt ? (
            <div className="mt-3 border-t border-[var(--ink-rule)] pt-2.5">
              <p className="text-[9px] font-extrabold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                原文补充
              </p>
              <p className="mt-1.5 line-clamp-4 whitespace-pre-line font-serif text-[12px] leading-[1.55] text-[var(--ink-muted)]">
                {supportingExcerpt}
              </p>
            </div>
          ) : null}
        </section>

        {detail.selectionReason?.trim() ? (
          <section className="mt-5 border-t border-[var(--ink-rule)] pt-3.5">
            <p className="text-[9px] font-extrabold uppercase tracking-[0.12em] text-[var(--ink-accent)]">
              为什么值得看
            </p>
            <p className="mt-2 text-[12px] leading-[1.55] text-[var(--ink-muted)]">{detail.selectionReason.trim()}</p>
          </section>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--ink-rule)] pt-3">
          <span className={cn('inline-flex min-h-6 items-center border px-2 text-[10px] font-bold', tierVisual.border, tierVisual.text)}>
            {tierLabel}
          </span>
          {tags.length ? (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span key={tag} className="border border-[var(--ink-rule)] px-1.5 py-0.5 text-[10px] text-[var(--ink-muted)]">
                  #{tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {detail.distilledScore ? (
          <details className="group mt-4 border-t border-[var(--ink-rule)] pt-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[10px] font-bold text-[var(--ink-muted)] hover:text-[var(--ink-accent)] [&::-webkit-details-marker]:hidden">
              <span>查看评分依据</span>
              <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <div className="pt-3">
              <DistilledScorePanel score={detail.distilledScore} effectiveTier={tier} embedded />
            </div>
          </details>
        ) : null}
      </div>

      <footer className="flex shrink-0 flex-wrap gap-2 border-t border-[var(--ink-rule)] bg-[var(--ink-paper)] px-4 py-2.5 sm:px-5">
        {sourceUrlAvailable ? (
          <button
            type="button"
            data-reader-url={readerUrl}
            onClick={() => setSourcePromptOpen(true)}
            className="inline-flex min-h-9 flex-1 items-center justify-center gap-2 bg-[var(--ink-accent)] px-3 text-[11px] font-bold text-white transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40"
          >
            {zreadUrl ? <Github className="size-3.5" aria-hidden /> : <ExternalLink className="size-3.5" aria-hidden />}
            {zreadUrl ? '打开 GitHub' : '打开原文'}
          </button>
        ) : null}
        {zreadUrl ? (
          <a
            href={zreadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-9 flex-1 items-center justify-center gap-2 border border-[var(--ink-rule)] px-3 text-[11px] font-bold text-[var(--ink-text)] transition-colors hover:border-[var(--ink-accent)] hover:text-[var(--ink-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40"
          >
            <BookOpen className="size-3.5" aria-hidden />
            打开 Zread
          </a>
        ) : null}
        <Link
          href={`/ai-research?seed=${encodeURIComponent(detail.id)}`}
          prefetch={false}
          className="inline-flex min-h-9 flex-1 items-center justify-center gap-2 border border-[var(--ink-rule)] px-3 text-[11px] font-bold text-[var(--ink-text)] transition-colors hover:border-[var(--ink-accent)] hover:text-[var(--ink-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40"
        >
          <Sparkles className="size-3.5" aria-hidden />
          深入调研
        </Link>
      </footer>
      {sourcePromptOpen ? (
        <ReaderSourcePrompt
          readerUrl={readerUrl}
          onClose={() => setSourcePromptOpen(false)}
          onOpen={openSource}
        />
      ) : null}
    </aside>
  );
}
