'use client';

// RadarCandidateCard —— 雷达候选卡（列表 / admin 队列共用）。
//
// 公开列表只展示来源、日期、标题、两行判断、阅读等级和收藏；标题是概览的唯一入口。
// 管理队列才附加状态、排序和管理操作。

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { space, tokens } from '@deep-research/design-system';
import { RadarFeedbackBar } from './RadarFeedbackBar';
import type { RadarFeedbackCounts } from './RadarFeedbackBar';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';
import { ArrowUpRight, BookOpenCheck, MessageSquare, Sparkles } from 'lucide-react';
import { CommentSection } from '@/components/CommentSection';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { readingTierColor } from '@/components/domain/ScoreBar';
import { AppButton as Button } from '@/components/material/AppButton';
import { AppTagLink } from '@/components/material/AppTagLink';
import { RadarSourceChip } from './RadarSourceChip';

interface RadarCandidate {
  id: string;
  title: string;
  excerpt: string;
  excerptDisplay?: 'full' | 'clamp';
  url: string;
  sourceType: string | null;
  sourceName?: string | null;
  tags: string[];
  status: string;
  publishedAt: string | null;
  crawledAt: string;
  interpretation: string | null;
  scoreReason: string | null;
  /** Effective, persisted reading tier; do not read the score target here. */
  tier: string | null;
  relevanceScore: number | null;
  timelinessScore: number | null;
  sourceQualityScore: number | null;
  distilledScore: DistilledScore | null;
  selectionReason: string | null;
  sortOrder: number | null;
  feedbackCounts: RadarFeedbackCounts;
  myFeedbacks: RadarFeedbackType[];
  commentCount: number;
  topics: Array<{ id: string; slug: string; name: string; tier: string }>;
  issues: Array<{
    id: string;
    title: string;
    kind: 'event' | 'problem';
    importanceScore: number;
    topic: { id: string; slug: string; name: string };
  }>;
}

interface RadarCandidateCardProps {
  candidate: RadarCandidate;
  /** 从列表进入详情时携带当前筛选和页码，详情页可准确返回。 */
  detailHref?: string;
  /** Admin 操作按钮组（select/dismiss/retry）；不传则不展示 */
  adminActions?: React.ReactNode;
  /** 当前登录用户（用于评论区交互）；不传则只读 */
  currentUserId?: string | null;
  currentUserRole?: 'member' | 'admin' | null;
  /** 统一排序流使用无卡片行，来源分组和 Admin 保留卡片容器。 */
  compact?: boolean;
  /** 在雷达页内打开文章概览；保留 href 以支持新标签页和直接访问。 */
  onOpenPreview?: (summaryId: string) => void;
  selected?: boolean;
}

function formatDate(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso.slice(0, 10);
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(ts));
}

export function RadarCandidateCard({
  candidate,
  detailHref,
  adminActions,
  currentUserId = null,
  currentUserRole = null,
  compact = false,
  onOpenPreview,
  selected = false,
}: RadarCandidateCardProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const prefetchStartedRef = useRef(false);
  const interpretation = candidate.interpretation;
  // 雷达没有写入 selectionReason 的管线，"为什么值得看"由 AI 摘要承担。
  const compactTeaser = interpretation?.trim()
    || candidate.excerpt?.trim()
    || null;
  const showExcerpt =
    !interpretation ||
    !candidate.excerpt ||
    !(
      candidate.excerpt.startsWith(interpretation) ||
      interpretation.startsWith(candidate.excerpt)
    );

  const isAdminQueue = Boolean(adminActions);
  const resolvedDetailHref = detailHref ?? `/radar/${candidate.id}`;
  const externalReading = candidate.tags.includes('external_reading');
  // External-reading candidates still pass through the detail landing page so
  // the user sees the Reader install prompt before leaving the platform.
  const readingHref = resolvedDetailHref;
  // ``distilledScore.tier`` is the score target. Render the persisted tier:
  // server-reading rows are gated by enrichment, while external-reading rows
  // retain their score tier and open through the source URL/Reader path.
  const tier = candidate.tier ?? null;
  const contentPending = candidate.tags.includes('content_pending');
  const showPipelinePending = isAdminQueue && contentPending;
  const tierScore = candidate.distilledScore?.tierScore
    ?? candidate.distilledScore?.total
    ?? null;
  const tierLabel =
    tier === 'deep_read'
        ? '精读'
        : tier === 'skim'
          ? '速读'
        : tier === 'collection'
          ? '精读'
          : tier === 'noise'
            ? '不推荐'
            : null;
  const prefetchDetail = () => {
    if (prefetchStartedRef.current) return;
    prefetchStartedRef.current = true;
    // Hover/focus is a stronger intent signal than prefetching every card in
    // a long list, and also warms the route in Next dev where viewport
    // prefetching is less predictable.
    void router.prefetch(resolvedDetailHref);
    void queryClient.prefetchQuery({
      queryKey: ['radar', candidate.id],
      queryFn: async () => {
        const response = await fetch(`/api/radar/${candidate.id}?surface=summary`, {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('雷达详情预取失败');
        return response.json();
      },
      staleTime: 30_000,
    });
  };
  const handlePreviewClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (
      !onOpenPreview
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) return;
    event.preventDefault();
    onOpenPreview(candidate.id);
  };

  return (
    <Box component="article" className="material-surface" sx={{
      display: 'flex', flexDirection: 'column', minWidth: 0, maxWidth: '100%', gap: space.sm, padding: space.lg,
      border: compact ? 0 : 1, borderBottom: 1, borderColor: 'divider', borderRadius: compact ? 0 : tokens['radius-medium'],
      backgroundColor: selected ? 'action.selected' : 'background.paper',
      boxShadow: selected ? 'inset 3px 0 0 var(--dr-color-primary)' : 'none',
      '&:last-child': compact ? { borderBottom: 0 } : {}, '&:hover': { backgroundColor: selected ? 'action.selected' : 'action.hover' },
    }}>
      <Box component="header" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.sm }}>
        {/* 等级 + 来源放在最前：扫雷达时最先要回答的是"值不值得看"。 */}
        {tierLabel ? (
          <Chip variant="outlined" size="small" label={isAdminQueue && tierScore !== null ? `${tierLabel} · ${tierScore}` : tierLabel} sx={{ color: readingTierColor(tier), borderColor: 'currentColor', fontVariantNumeric: 'tabular-nums' }} />
        ) : null}
        <RadarSourceChip sourceType={candidate.sourceType} sourceName={candidate.sourceName} />
        {isAdminQueue ? <StatusBadge kind="radar" value={candidate.status} /> : null}
        {showPipelinePending ? (
          <Chip size="small" label="内容管线待处理" sx={{ color: 'warning.main', bgcolor: 'var(--dr-color-warning-container)' }} />
        ) : null}
        {isAdminQueue && candidate.sortOrder !== null ? (
          <Typography variant="metadata" color="text.secondary">#{candidate.sortOrder}</Typography>
        ) : null}
        <Typography component="span" variant="metadata" color="text.secondary" sx={{ marginLeft: 'auto' }} title={`入库于 ${candidate.crawledAt}`}>
          入库 {formatDate(candidate.crawledAt)}
        </Typography>
      </Box>

      <Typography component={Link} variant="listTitle"
        href={readingHref}
        prefetch={false}
        onMouseEnter={prefetchDetail}
        onFocus={prefetchDetail}
        onClick={handlePreviewClick}
        data-radar-preview-trigger={candidate.id}
        aria-current={selected ? 'page' : undefined}
        sx={{ color: 'text.primary', overflowWrap: 'anywhere', textDecoration: 'none', '&:hover': { color: 'primary.main', textDecoration: 'underline' } }}
      >
        {candidate.title}
      </Typography>

      {compact && selected ? null : compact ? (
        compactTeaser ? (
          <Typography component="p" variant="body1" color="text.secondary" sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-line' }}>
            {compactTeaser}
          </Typography>
        ) : null
      ) : candidate.interpretation ? (
        <Typography component="p" variant="body1" color="text.secondary" sx={{ whiteSpace: 'pre-line' }}>
          <Typography component="span" variant="metadata" color="text.secondary" sx={{ marginRight: space.sm }}>AI 摘要：</Typography>
          {candidate.interpretation}
        </Typography>
      ) : showExcerpt ? (
        // arxiv abstracts / 长文导言（avg_len >= 200 或 ≤3 段）→ 完整显示；
        // 对话 / 流水账 web_share 内容（多数短段落）→ clamp-5 抑制对话墙。
        // 服务端 shape.ts 的 classifyExcerptDisplay 已经按 excerpt 段落结构分类。
        <Typography component="p" variant="body1" color="text.secondary" sx={{ whiteSpace: 'pre-line', ...(candidate.excerptDisplay !== 'full' ? { display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}) }}>
          {candidate.excerpt}
        </Typography>
      ) : null}

      {candidate.topics.length > 0 || candidate.issues.length > 0 ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.sm }} aria-label="关联专题与议题">
          {candidate.topics.slice(0, 2).map((t) => (
            <AppTagLink
              key={`topic-${t.id}`}
              href={`/topics/${t.slug}`}
              icon={<BookOpenCheck aria-hidden />} label={t.name}
            />
          ))}
          {candidate.issues.slice(0, 2).map((iss) => (
            <AppTagLink
              key={`issue-${iss.id}`}
              href={`/topics/${iss.topic.slug}`}
              icon={<Sparkles aria-hidden />} label={iss.title} title={iss.title}
              tone={iss.kind === 'event' ? 'info' : 'error'}
            />
          ))}
        </Box>
      ) : null}

      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: space.sm, borderTop: 1, borderColor: 'divider', paddingTop: space.sm }}>
        <RadarFeedbackBar
          summaryId={candidate.id}
          initialCounts={candidate.feedbackCounts}
          initialMine={candidate.myFeedbacks}
          types={['favorite']}
        />
        {candidate.commentCount > 0 ? (
          <Button
            type="button"
            variant={discussionOpen ? 'contained' : 'outlined'}
            size="small"
            sx={{ flexShrink: 0 }}
            aria-expanded={discussionOpen}
            aria-controls={`discussion-${candidate.id}`}
            onClick={() => setDiscussionOpen((open) => !open)}
          >
            <MessageSquare size={16} aria-hidden />
            {candidate.commentCount} 条讨论
          </Button>
        ) : null}
        {!compact && currentUserId ? (
          <Button component={Link}
            href={`/ai-research?seed=${encodeURIComponent(candidate.id)}`}
            prefetch={false}
          >
            深入调研
            <Sparkles size={16} aria-hidden />
          </Button>
        ) : null}
        {!onOpenPreview ? (
          <Button component={Link}
            href={readingHref}
            prefetch={false}
            onMouseEnter={prefetchDetail}
            onFocus={prefetchDetail}
            onClick={handlePreviewClick}
            sx={{ marginLeft: 'auto' }}
          >
            {externalReading ? '阅读原文' : '打开详情'}
            <ArrowUpRight size={16} aria-hidden />
          </Button>
        ) : null}
      </Box>

      {adminActions ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, borderTop: 1, borderColor: 'divider', paddingTop: space.sm }}>{adminActions}</Box>
      ) : null}

      {discussionOpen ? (
        <Box id={`discussion-${candidate.id}`} sx={{ minWidth: 0 }}>
          <CommentSection
            targetType="summary"
            targetId={candidate.id}
            currentUserId={currentUserId}
            currentUserRole={currentUserRole}
            compact
          />
        </Box>
      ) : null}
    </Box>
  );
}
