'use client';

import Link from 'next/link';
import React from 'react';
import { useEffect, useState } from 'react';
import {
  BookOpen,
  BookOpenCheck,
  ChevronDown,
  ExternalLink,
  Github,
  Sparkles,
} from 'lucide-react';

import type { DistilledScore } from '@deep-research/shared/schemas';
import { BackToSearchButton } from '../domain/BackToSearchButton';
import { decodeRadarTextEntities } from './radar-reading-blocks';
import { DistilledScorePanel } from './DistilledScorePanel';
import {
  formatRadarContentKind,
  formatSourceType,
} from '../../lib/radar/source-labels';
import { TIER_LABELS, tierClasses } from '../domain/ScoreBar';
import { cn } from '../../lib/utils';
import { zreadRepositoryUrl } from './radar-repository';

export interface ExternalReadingDetail {
  id: string;
  title: string;
  excerpt: string;
  interpretation: string | null;
  scoreReason: string | null;
  distilledScore: DistilledScore | null;
  tier: string | null;
  selectionReason: string | null;
  url: string;
  sourceType: string | null;
  sourceName: string | null;
  originalKind?: string | null;
  tags?: string[];
  publishedAt?: string | null;
  isAuthenticated?: boolean;
}

export function externalReaderUrl(
  sourceUrl: string,
  summaryId: string,
  platformUrl?: string | null,
): string {
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return sourceUrl;
    url.searchParams.set('deep-research-source', 'radar');
    url.searchParams.set('deep-research-summary', summaryId);
    if (platformUrl) {
      const platform = new URL(platformUrl);
      if (platform.protocol === 'http:' || platform.protocol === 'https:') {
        url.searchParams.set('deep-research-platform', platform.origin);
      }
    }
    return url.toString();
  } catch {
    return sourceUrl;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function formatRadarDetailDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function cleanRadarTags(tags: string[] | undefined): string[] {
  return (tags ?? []).filter((tag) => {
    if (!tag || tag.startsWith('tier_') || tag.startsWith('profile_')) return false;
    if (tag.startsWith('veto_') || tag.startsWith('risk_')) return false;
    if (tag.startsWith('migration_') || tag.endsWith('_pending')) return false;
    return ![
      'rss',
      'api',
      'web',
      'github',
      'tracked',
      'repo_digest',
      'content_pending',
      'fetch_failed_shell',
      'paywall_stub',
    ].includes(tag);
  }).slice(0, 4);
}

export function ReaderSourcePrompt({
  readerUrl,
  onClose,
  onOpen,
}: {
  readerUrl: string;
  onClose: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-5"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="w-full max-w-md border border-[var(--ink-rule)] bg-[var(--ink-page)] p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reader-source-prompt-title"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[9px] font-extrabold uppercase tracking-[0.13em] text-[var(--ink-accent)]">
              Reader
            </p>
            <h2 id="reader-source-prompt-title" className="mt-2 text-lg font-semibold text-[var(--ink-text)]">
              先确认你已安装 Reader
            </h2>
          </div>
          <button
            type="button"
            className="text-lg leading-none text-[var(--ink-muted)] hover:text-[var(--ink-text)]"
            aria-label="关闭安装提示"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
          原文会在新标签页打开。若还没有安装扩展，先完成安装；回到原文后点击浏览器工具栏里的 Reader，再启用当前站点。
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Link
            href="/reading/install"
            className="inline-flex min-h-9 items-center justify-center border border-[var(--ink-rule)] px-3 text-[11px] font-bold text-[var(--ink-text)] hover:border-[var(--ink-accent)] hover:text-[var(--ink-accent)]"
          >
            先安装 Reader
          </Link>
          <button
            type="button"
            onClick={onOpen}
            data-reader-url={readerUrl}
            className="inline-flex min-h-9 items-center justify-center bg-[var(--ink-accent)] px-3 text-[11px] font-bold text-white hover:brightness-95"
          >
            我已安装，继续打开
          </button>
        </div>
      </section>
    </div>
  );
}

export function radarSummaryParts(detail: Pick<ExternalReadingDetail, 'excerpt' | 'interpretation'>) {
  const interpretation = detail.interpretation?.trim() || null;
  const excerpt = detail.excerpt?.trim() || null;
  const lead = interpretation || excerpt || '雷达暂未生成一句话判断。';
  const supportingExcerpt = interpretation
    && excerpt
    && excerpt !== interpretation
    && !excerpt.startsWith(interpretation)
    && !interpretation.startsWith(excerpt)
    ? excerpt
    : null;

  return { lead, supportingExcerpt };
}

export function RadarExternalReadingLanding({
  detail,
  backHref = '/radar',
}: {
  detail: ExternalReadingDetail;
  backHref?: string;
}) {
  const [platformOrigin, setPlatformOrigin] = useState<string | null>(null);
  const [sourcePromptOpen, setSourcePromptOpen] = useState(false);

  useEffect(() => {
    setPlatformOrigin(window.location.origin);
  }, []);

  const sourceLabel = formatSourceType(detail.sourceType);
  const sourceName = detail.sourceName?.trim() || sourceLabel.short;
  const contentLabel = formatRadarContentKind(detail.originalKind, detail.sourceType, detail.url);
  const readerUrl = externalReaderUrl(detail.url, detail.id, platformOrigin);
  const sourceUrlAvailable = isHttpUrl(detail.url);
  const zreadUrl = detail.originalKind === 'github_repo'
    ? zreadRepositoryUrl(detail.url)
    : null;
  const tier = detail.tier ?? detail.distilledScore?.tier ?? null;
  const tierLabel = tier ? (TIER_LABELS[tier] ?? tier) : '待判断';
  const tierVisual = tierClasses(tier ?? 'collection');
  const { lead: summaryLead, supportingExcerpt } = radarSummaryParts(detail);
  const selectionReason = detail.selectionReason?.trim() || null;
  const tags = cleanRadarTags(detail.tags);
  const publishedLabel = formatRadarDetailDate(detail.publishedAt);
  const displayTitle = decodeRadarTextEntities(detail.title);
  const openSource = () => {
    setSourcePromptOpen(false);
    window.open(readerUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--ink-page)] font-sans">
      <header className="sticky top-0 z-20 flex min-h-12 items-center justify-between gap-3 border-b border-[var(--ink-rule)] bg-[var(--ink-page)]/95 px-4 backdrop-blur sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <BackToSearchButton />
          <Link
            href={backHref}
            className="inline-flex min-h-9 items-center gap-2 text-xs font-semibold text-[var(--ink-muted)] transition-colors hover:text-[var(--ink-accent)]"
          >
            <span aria-hidden>←</span>
            <span className="hidden sm:inline">回到雷达</span>
            <span className="sm:hidden">雷达</span>
          </Link>
          <span className="hidden text-xs text-[var(--ink-faint)] sm:inline">/</span>
          <span className="hidden truncate text-xs text-[var(--ink-faint)] sm:inline">详情简报</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {sourceUrlAvailable ? (
            <button
              type="button"
              data-reader-url={readerUrl}
              onClick={() => setSourcePromptOpen(true)}
              className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 bg-[var(--ink-accent)] px-3 text-[11px] font-bold text-white transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40"
            >
              {zreadUrl ? <Github className="size-3.5" aria-hidden /> : <ExternalLink className="size-3.5" aria-hidden />}
              <span>{zreadUrl ? '打开 GitHub' : '打开原文'}</span>
            </button>
          ) : null}
          {zreadUrl ? (
            <a
              href={zreadUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 border border-[var(--ink-rule)] px-3 text-[11px] font-bold text-[var(--ink-text)] transition-colors hover:border-[var(--ink-accent)] hover:text-[var(--ink-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40"
            >
              <BookOpen className="size-3.5" aria-hidden />
              <span>打开 Zread</span>
            </a>
          ) : null}
        </div>
      </header>

      {sourcePromptOpen ? (
        <ReaderSourcePrompt
          readerUrl={readerUrl}
          onClose={() => setSourcePromptOpen(false)}
          onOpen={openSource}
        />
      ) : null}

      <main className="mx-auto w-full max-w-7xl px-5 py-6 sm:px-8 sm:py-8 lg:py-10">
        <section className="max-w-5xl">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[10px] font-semibold text-[var(--ink-muted)]">
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

          <h1 className="mt-4 max-w-4xl break-words font-serif text-2xl font-semibold leading-[1.12] tracking-normal text-[var(--ink-text)] [overflow-wrap:anywhere] sm:text-3xl lg:text-4xl">
            {displayTitle}
          </h1>

          <div className="mt-6 grid gap-7 lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-8">
            <div className="min-w-0">
              <div className="border-l-2 border-[var(--ink-accent)] pl-3.5 sm:pl-4">
                <div className="flex items-center gap-2 text-[9px] font-extrabold uppercase tracking-[0.13em] text-[var(--ink-accent)]">
                  <Sparkles className="size-3" aria-hidden />
                  AI 摘要
                </div>
                <p className="mt-2 whitespace-pre-line font-serif text-[15px] leading-[1.6] text-[var(--ink-text)] sm:text-[16px]">
                  {summaryLead}
                </p>
                {supportingExcerpt ? (
                  <div className="mt-4 border-t border-[var(--ink-rule)] pt-3">
                    <p className="text-[9px] font-extrabold uppercase tracking-[0.13em] text-[var(--ink-muted)]">
                      原文补充
                    </p>
                    <p className="mt-2 whitespace-pre-line font-serif text-[13px] leading-[1.6] text-[var(--ink-muted)] sm:text-[14px]">
                      {supportingExcerpt}
                    </p>
                  </div>
                ) : null}
              </div>
            </div>

            <aside className="min-w-0 border-y border-[var(--ink-rule)] py-4 lg:border-y-0 lg:border-l lg:pl-5 lg:pt-0">
              {selectionReason ? (
                <>
                  <p className="text-[9px] font-extrabold uppercase tracking-[0.13em] text-[var(--ink-accent)]">
                    为什么值得看
                  </p>
                  <p className="mt-2 text-[13px] leading-[1.55] text-[var(--ink-muted)]">{selectionReason}</p>
                </>
              ) : null}

              <div className={cn(
                'flex flex-wrap items-center gap-2',
                selectionReason
                  ? 'mt-5 border-t border-[var(--ink-rule)] pt-4'
                  : '',
              )}
              >
                <span className={cn('inline-flex min-h-6 items-center border px-2 text-[10px] font-bold', tierVisual.border, tierVisual.text)}>
                  {tierLabel}
                </span>
                {tags.length > 0 ? (
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
            </aside>
          </div>
        </section>

        <section id="source-reading" className="mt-8 border-t border-[var(--ink-rule)] pt-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-2xl">
              <div className="flex items-center gap-2 text-[9px] font-extrabold uppercase tracking-[0.13em] text-[var(--ink-accent)]">
                <BookOpenCheck className="size-3.5" aria-hidden />
                Reader
              </div>
              <p className="mt-1.5 text-[12px] leading-[1.55] text-[var(--ink-muted)]">
                在来源网站继续阅读、保存和同步；只有你明确保存时才会上传内容。
              </p>
            </div>
            <Link
              href="/reading/install"
              className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 border border-[var(--ink-rule)] px-3 text-[11px] font-bold text-[var(--ink-text)] transition-colors hover:border-[var(--ink-accent)] hover:text-[var(--ink-accent)]"
            >
              <BookOpenCheck className="size-3.5" aria-hidden />
              安装 Reader
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
