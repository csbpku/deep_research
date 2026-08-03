'use client';

// RadarCandidateCard —— 雷达候选卡（列表 / admin 队列共用）。
//
// 列表卡（瘦身后）展示：来源 + 状态 + 标题 + AI 一句话解读（1 行 truncate）
//   + 标签 + tier 总分 + 反馈条 + 讨论。
// 7 维评分明细、scoreReason 全文、selectionReason 都下沉到详情页。
// admin 队列在 footer 多挂一行操作按钮（select/dismiss）。

import Link from 'next/link';
import { useState } from 'react';
import { MessageSquare } from 'lucide-react';

import { RadarFeedbackBar } from './RadarFeedbackBar';
import type { RadarFeedbackCounts } from './RadarFeedbackBar';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';
import { CommentSection } from '@/components/CommentSection';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { TagChip, TagList } from '@/components/domain/TagChip';
import { Button } from '@/components/ui/button';
import { formatSourceType } from '@/lib/radar/source-labels';
import { useCurrentUser } from '@/lib/auth/client';
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

const HIDDEN_TAGS = new Set([
  'must_read',
  'rss',
  'api',
  'web',
  'github',
  'tracked',
  'repo_digest',
  'pr_soft',
]);

function isInternalTag(tag: string): boolean {
  return (
    tag === 'must_read' ||
    tag.startsWith('tier_') ||
    tag.startsWith('profile_') ||
    tag.startsWith('veto_') ||
    tag.startsWith('risk_') ||
    HIDDEN_TAGS.has(tag)
  );
}

function formatCrawledAt(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso.slice(0, 10);
  const delta = Date.now() - ts;
  if (delta < 0) return new Date(iso).toISOString().slice(0, 10);
  const min = Math.floor(delta / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
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
  const [commentsOpen, setCommentsOpen] = useState(false);
  const me = useCurrentUser();
  const interpretation = candidate.interpretation;
  const showExcerpt =
    !interpretation ||
    !candidate.excerpt ||
    !(
      candidate.excerpt.startsWith(interpretation) ||
      interpretation.startsWith(candidate.excerpt)
    );

  const displayTags = candidate.tags.filter((t) => !isInternalTag(t)).slice(0, 3);

  // tier chip：detail 上 7 维 panel 仍展示，列表只给一个总数 + tier 名字。
  const tier = candidate.distilledScore?.tier ?? null;
  const tierScore = candidate.distilledScore?.total ?? null;
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
        <StatusBadge kind="radar" value={candidate.status} />
        {candidate.sortOrder !== null ? (
          <span className="font-mono text-[11px] text-muted-foreground">#{candidate.sortOrder}</span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground" title={new Date(candidate.crawledAt).toISOString()}>
          {formatCrawledAt(candidate.crawledAt)}
        </span>
      </header>

      <Link
        href={`/radar/${candidate.id}`}
        className="text-base font-semibold leading-snug hover:text-primary hover:underline"
      >
        {candidate.title}
      </Link>

      {candidate.interpretation ? (
        <p className="truncate text-sm leading-relaxed text-muted-foreground">
          <span className="mr-1.5 text-[11px] text-foreground/70">AI 解读：</span>
          {candidate.interpretation}
        </p>
      ) : showExcerpt ? (
        <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
          {candidate.excerpt}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {displayTags.length > 0 ? (
          <TagList className="gap-1">
            {displayTags.map((t) => (
              <TagChip key={t}>#{t}</TagChip>
            ))}
          </TagList>
        ) : null}
        {tierLabel ? (
          <span className={tierClass} title={tierLabel ?? undefined}>
            {tierLabel}
            {tierScore !== null ? (
              <span className="font-mono tabular-nums">· {tierScore}</span>
            ) : null}
          </span>
        ) : null}
      </div>

      <div className="flex max-w-full flex-nowrap items-center gap-1 border-t border-border pt-2">
        <RadarFeedbackBar
          summaryId={candidate.id}
          initialCounts={candidate.feedbackCounts}
          initialMine={candidate.myFeedbacks}
          className="shrink-0 gap-1 py-0"
        />
        <span className="h-5 w-px shrink-0 bg-border" aria-hidden />
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="h-7 w-7 shrink-0 px-0"
          aria-label="讨论"
          aria-expanded={commentsOpen}
          onClick={() => setCommentsOpen((v) => !v)}
        >
          <MessageSquare />
        </Button>
      </div>

      {commentsOpen ? (
        <CommentSection
          targetType="summary"
          targetId={candidate.id}
          currentUserId={me.data?.id ?? null}
          currentUserRole={me.data?.role ?? null}
        />
      ) : null}

      {adminActions ? (
        <div className="flex flex-wrap gap-1.5 border-t border-border pt-2">{adminActions}</div>
      ) : null}
    </article>
  );
}
