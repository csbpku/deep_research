// RadarCandidateCard —— 雷达候选卡（列表 / admin 队列共用）。
//
// 展示：来源图标 + 标题 + excerpt + 标签 + 评分 + AI 一句话解读 + 反馈条。
// 列表上整卡可点击进入详情；admin 队列提供额外操作按钮（select/dismiss）。
//
// 评分理由的展示策略：
//   - 列表卡片：truncate 到 ~30 字作为 chip，hover 用 Radix Tooltip 展示完整理由
//   - 详情页：见 src/app/radar/[id]/page.tsx 的可折叠 disclosure

'use client';

import Link from 'next/link';
import { useState } from 'react';
import { MessageSquare, Sparkles } from 'lucide-react';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { RadarFeedbackBar } from './RadarFeedbackBar';
import type { RadarFeedbackCounts } from './RadarFeedbackBar';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';
import { DistilledScorePanel } from './DistilledScorePanel';
import { CommentSection } from '@/components/CommentSection';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { TagChip, TagList } from '@/components/domain/TagChip';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/lib/auth/client';

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

function SourceIcon({ sourceType }: { sourceType: string | null }) {
  const label = sourceType ?? 'unknown';
  return (
    <span
      className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground"
      aria-label={`来源类型 ${label}`}
    >
      {label}
    </span>
  );
}

export function RadarCandidateCard({ candidate, adminActions }: RadarCandidateCardProps) {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const me = useCurrentUser();
  const interpretation = candidate.interpretation;
  const showExcerpt = !interpretation
    || !candidate.excerpt
    || !(
      candidate.excerpt.startsWith(interpretation)
      || interpretation.startsWith(candidate.excerpt)
    );

  return (
    <article className="flex min-w-0 max-w-full flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-center gap-2">
        <SourceIcon sourceType={candidate.sourceType} />
        <StatusBadge kind="radar" value={candidate.status} />
        {candidate.sortOrder !== null ? (
          <span className="font-mono text-[11px] text-muted-foreground">#{candidate.sortOrder}</span>
        ) : null}
        <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
          {new Date(candidate.crawledAt).toISOString().slice(0, 10)}
        </span>
      </header>

      <Link
        href={`/radar/${candidate.id}`}
        className="text-base font-semibold leading-snug hover:text-primary hover:underline"
      >
        {candidate.title}
      </Link>

      {candidate.interpretation ? (
        <blockquote className="rounded-r-md border-l-2 border-l-primary bg-muted/50 px-3 py-2 text-sm leading-relaxed">
          <span className="mr-1.5 text-[11px] text-muted-foreground">AI 一句话解读：</span>
          {candidate.interpretation}
        </blockquote>
      ) : null}

      {showExcerpt ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{candidate.excerpt}</p>
      ) : null}

      {(() => {
        const displayTags = candidate.tags.filter((t) => {
          if (t === 'must_read' || t.startsWith('tier_') || t.startsWith('profile_') || t.startsWith('veto_') || t.startsWith('risk_')) return false;
          if (t === 'rss' || t === 'api' || t === 'web' || t === 'github' || t === 'tracked' || t === 'repo_digest' || t === 'pr_soft') return false;
          return true;
        });
        if (displayTags.length === 0) return null;
        return (
          <TagList className="gap-1">
            {displayTags.map((t) => (
              <TagChip key={t}>#{t}</TagChip>
            ))}
          </TagList>
        );
      })()}

      {!candidate.distilledScore && candidate.scoreReason ? (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex max-w-full items-center gap-1 self-start rounded-full border border-status-partial-fg/30 bg-status-partial-bg px-2 py-0.5 text-left text-[11px] text-status-partial-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Sparkles className="size-3 shrink-0" aria-hidden />
                <span className="truncate">
                  理由：
                  {candidate.scoreReason.length > 30
                    ? candidate.scoreReason.slice(0, 30) + '…'
                    : candidate.scoreReason}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              align="start"
              className="max-w-sm whitespace-pre-wrap leading-relaxed"
            >
              <p className="mb-1 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <Sparkles className="size-3" aria-hidden />
                AI 评分理由
              </p>
              <p>{candidate.scoreReason}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}

      {candidate.selectionReason ? (
        <p className="text-sm text-status-succeeded-fg">
          <strong className="font-medium">入选理由：</strong>
          {candidate.selectionReason}
        </p>
      ) : null}

      <div className="flex max-w-full flex-nowrap items-center gap-1 overflow-x-auto border-t border-border pt-2">
        {candidate.distilledScore ? (
          <DistilledScorePanel score={candidate.distilledScore} compact />
        ) : null}
        <span className="h-5 w-px shrink-0 bg-border" aria-hidden />
        <RadarFeedbackBar
          summaryId={candidate.id}
          initialCounts={candidate.feedbackCounts}
          initialMine={candidate.myFeedbacks}
          className="shrink-0 gap-1 py-0"
        />
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
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
            </TooltipTrigger>
            <TooltipContent>讨论</TooltipContent>
          </Tooltip>
        </TooltipProvider>
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
        <div className="flex flex-wrap gap-2 border-t border-border pt-2">{adminActions}</div>
      ) : null}
    </article>
  );
}
