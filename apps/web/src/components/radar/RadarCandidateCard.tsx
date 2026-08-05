'use client';

// RadarCandidateCard —— 雷达候选卡（列表 / admin 队列共用）。
//
// 公开列表只展示来源、日期、标题、两行解读、阅读等级、收藏和详情入口。
// 管理队列才附加状态、排序和管理操作。

import Link from 'next/link';
import { RadarFeedbackBar } from './RadarFeedbackBar';
import type { RadarFeedbackCounts } from './RadarFeedbackBar';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { Button } from '@/components/ui/button';
import { formatSourceType } from '@/lib/radar/source-labels';
import { cn } from '@/lib/utils';

interface RadarCandidate {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  sourceType: string | null;
  tags: string[];
  status: string;
  publishedAt: string | null;
  crawledAt: string;
  interpretation: string | null;
  scoreReason: string | null;
  relevanceScore: number | null;
  timelinessScore: number | null;
  sourceQualityScore: number | null;
  distilledScore: DistilledScore | null;
  selectionReason: string | null;
  sortOrder: number | null;
  feedbackCounts: RadarFeedbackCounts;
  myFeedbacks: RadarFeedbackType[];
}

interface RadarCandidateCardProps {
  candidate: RadarCandidate;
  /** Admin 操作按钮组（select/dismiss/retry）；不传则不展示 */
  adminActions?: React.ReactNode;
}

function formatDate(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso.slice(0, 10);
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(ts));
}

function SourcePill({ sourceType }: { sourceType: string | null }) {
  const label = formatSourceType(sourceType);
  return (
    <span
      className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
      aria-label={label.full}
      title={label.full}
    >
      {label.short}
    </span>
  );
}

export function RadarCandidateCard({ candidate, adminActions }: RadarCandidateCardProps) {
  const interpretation = candidate.interpretation;
  const showExcerpt =
    !interpretation ||
    !candidate.excerpt ||
    !(
      candidate.excerpt.startsWith(interpretation) ||
      interpretation.startsWith(candidate.excerpt)
    );

  const isAdminQueue = Boolean(adminActions);
  const tier = candidate.distilledScore?.tier ?? null;
  const tierScore = candidate.distilledScore?.rankingScore
    ?? candidate.distilledScore?.effectiveTotal
    ?? candidate.distilledScore?.total
    ?? null;
  const tierLabel =
    tier === 'deep_read'
      ? '深度阅读'
      : tier === 'skim'
        ? '略读'
        : tier === 'collection'
          ? '收藏'
          : tier === 'noise'
            ? '噪声'
            : null;
  const tierClass = cn(
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
    tier === 'deep_read' && 'border-tier-deep-read/40 text-tier-deep-read',
    tier === 'skim' && 'border-tier-skim/40 text-tier-skim',
    tier === 'collection' && 'border-tier-collection/40 text-tier-collection',
    tier === 'noise' && 'border-tier-noise/40 text-tier-noise',
    !tier && 'hidden',
  );

  return (
    <article className="flex min-w-0 max-w-full flex-col gap-2 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/30">
      <header className="flex flex-wrap items-center gap-2">
        <SourcePill sourceType={candidate.sourceType} />
        {isAdminQueue ? <StatusBadge kind="radar" value={candidate.status} /> : null}
        {isAdminQueue && candidate.sortOrder !== null ? (
          <span className="font-mono text-[11px] text-muted-foreground">#{candidate.sortOrder}</span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground" title={candidate.publishedAt ?? candidate.crawledAt}>
          {formatDate(candidate.publishedAt ?? candidate.crawledAt)}
        </span>
      </header>

      <Link
        href={`/radar/${candidate.id}`}
        className="text-base font-semibold leading-snug hover:text-primary hover:underline"
      >
        {candidate.title}
      </Link>

      {candidate.interpretation ? (
        <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
          <span className="mr-1.5 text-[11px] text-foreground/70">AI 解读：</span>
          {candidate.interpretation}
        </p>
      ) : showExcerpt ? (
        <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
          {candidate.excerpt}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
        {tierLabel ? (
          <span className={tierClass} title={tierLabel ?? undefined}>
            {tierLabel}
            {tierScore !== null ? (
              <span className="font-mono tabular-nums">· {tierScore}</span>
            ) : null}
          </span>
        ) : null}
        <RadarFeedbackBar
          summaryId={candidate.id}
          initialCounts={candidate.feedbackCounts}
          initialMine={candidate.myFeedbacks}
          types={['favorite']}
          className="shrink-0 gap-1 py-0"
        />
        <Button asChild type="button" variant="ghost" size="xs">
          <Link href={`/radar/${candidate.id}`}>查看详情</Link>
        </Button>
      </div>

      {adminActions ? (
        <div className="flex flex-wrap gap-1.5 border-t border-border pt-2">{adminActions}</div>
      ) : null}
    </article>
  );
}
