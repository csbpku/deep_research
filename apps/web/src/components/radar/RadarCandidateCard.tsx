'use client';

// RadarCandidateCard —— 雷达候选卡（列表 / admin 队列共用）。
//
// 公开列表只展示来源、日期、标题、两行解读、阅读等级、收藏和详情入口。
// 管理队列才附加状态、排序和管理操作。

import Link from 'next/link';
import { useState } from 'react';
import { RadarFeedbackBar } from './RadarFeedbackBar';
import type { RadarFeedbackCounts } from './RadarFeedbackBar';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';
import { MessageSquare } from 'lucide-react';
import { CommentSection } from '@/components/CommentSection';
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
  commentCount: number;
}

interface RadarCandidateCardProps {
  candidate: RadarCandidate;
  /** 登录成员操作（例如从候选发起深入调研）；不传则不展示 */
  memberActions?: React.ReactNode;
  /** Admin 操作按钮组（select/dismiss/retry）；不传则不展示 */
  adminActions?: React.ReactNode;
  /** 当前登录用户（用于评论区交互）；不传则只读 */
  currentUserId?: string | null;
  currentUserRole?: 'member' | 'admin' | null;
  /** 统一排序流使用无卡片行，来源分组和 Admin 保留卡片容器。 */
  compact?: boolean;
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

export function RadarCandidateCard({
  candidate,
  memberActions,
  adminActions,
  currentUserId = null,
  currentUserRole = null,
  compact = false,
}: RadarCandidateCardProps) {
  const [discussionOpen, setDiscussionOpen] = useState(false);
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
          ? '重点阅读'
          : tier === 'noise'
            ? '不推荐'
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
    <article className={cn(
      'flex min-w-0 max-w-full flex-col gap-2 transition-colors',
      compact
        ? 'border-b border-border px-4 py-4 last:border-b-0 hover:bg-accent/30'
        : 'rounded-md border border-border bg-card p-4 hover:border-primary/30',
    )}>
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
        className="text-base font-semibold leading-snug tracking-normal hover:text-primary hover:underline"
      >
        {candidate.title}
      </Link>

      {candidate.interpretation ? (
        <p className="line-clamp-2 text-sm leading-7 text-muted-foreground">
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
        {candidate.commentCount > 0 ? (
          <Button
            type="button"
            variant={discussionOpen ? 'default' : 'outline'}
            size="xs"
            className="shrink-0"
            aria-expanded={discussionOpen}
            aria-controls={`discussion-${candidate.id}`}
            onClick={() => setDiscussionOpen((open) => !open)}
          >
            <MessageSquare className="size-3.5" />
            {candidate.commentCount} 条讨论
          </Button>
        ) : null}
        {memberActions}
        <Link
          href={`/radar/${candidate.id}`}
          className="shrink-0 text-xs font-medium text-primary hover:underline"
        >
          查看详情 →
        </Link>
      </div>

      {adminActions ? (
        <div className="flex flex-wrap gap-1.5 border-t border-border pt-2">{adminActions}</div>
      ) : null}

      {discussionOpen ? (
        <div id={`discussion-${candidate.id}`} className="min-w-0">
          <CommentSection
            targetType="summary"
            targetId={candidate.id}
            currentUserId={currentUserId}
            currentUserRole={currentUserRole}
            compact
          />
        </div>
      ) : null}
    </article>
  );
}
