'use client';

// RadarReadingOverview —— 雷达阅读概览的唯一实现。
//
// 列表右侧预览（RadarPreviewPanel）与站外阅读详情页
// （RadarExternalReadingLanding）都渲染这个组件，区别只在容器：
//   - 容器外壳（预览头/关闭、详情页返回栏）由调用方负责；
//   - 侧栏把操作区固定在 footer（见 RadarReadingActions），详情页内联在正文末尾；
//   - 讨论/历史等次级内容通过 children 追加，不复制概览字段。
//
// P0-5 契约：每个 surface 只有一个主 CTA（打开原文，GitHub 仓库为打开
// GitHub），Reader 是 outlined 次级入口，且每个 surface 只出现一次。

import Link from 'next/link';
import React from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import {
  BookOpenCheck,
  ChevronDown,
  ExternalLink,
  Github,
  Sparkles,
} from 'lucide-react';
import { space } from '@deep-research/design-system';

import { AppButton } from '@/components/material/AppButton';
import { TIER_LABELS, readingTierColor } from '@/components/domain/ScoreBar';
import { READER_STORE_URL } from '@/lib/reader-install';
import { radarEvidenceNotice } from '@/lib/radar/evidence';
import { formatRadarContentKind, formatSourceType } from '@/lib/radar/source-labels';

import { DistilledScorePanel } from './DistilledScorePanel';
import {
  RadarFeedbackBar,
  RADAR_PRIMARY_FEEDBACK_TYPES,
  emptyRadarFeedbackCounts,
} from './RadarFeedbackBar';
import { PreviousJudgments, RadarKnowledgeActions } from './RadarKnowledgeActions';
import { RadarSourceChip } from './RadarSourceChip';
import { ReaderSourcePrompt } from './ReaderSourcePrompt';
import { decodeRadarTextEntities } from './radar-reading-blocks';
import {
  cleanRadarTags,
  externalReaderUrl,
  formatRadarDetailDate,
  isHttpUrl,
  radarReadingTier,
  radarSummaryParts,
  type ExternalReadingDetail,
} from './radar-reading-detail';
import { effectiveOriginalKind, zreadRepositoryUrl } from './radar-repository';

export type RadarReadingOverviewVariant = 'page' | 'panel';

/** 阅读判断与收藏共用同一条反馈带，两个入口不再各挑一半。 */
const OVERVIEW_FEEDBACK_TYPES = [...RADAR_PRIMARY_FEEDBACK_TYPES, 'favorite'] as const;

export interface RadarReadingOverviewProps {
  detail: ExternalReadingDetail;
  variant?: RadarReadingOverviewVariant;
  /**
   * `inline`：全页把操作区放在概览正文末尾。
   * `none`：侧栏由外层固定 footer 渲染 `RadarReadingActions`，避免嵌套滚动。
   */
  actions?: 'inline' | 'none';
  /** 次级内容（例如讨论），追加在共享概览之后。 */
  children?: React.ReactNode;
  className?: string;
}

export function RadarReadingOverview({
  detail,
  variant = 'page',
  actions = 'inline',
  children,
  className,
}: RadarReadingOverviewProps) {
  const isPage = variant === 'page';
  const titleComponent = isPage ? 'h1' : 'h2';
  const sectionHeading = isPage ? 'h2' : 'h3';
  const sourceLabel = formatSourceType(detail.sourceType);
  const sourceName = detail.sourceName?.trim() || sourceLabel.short;
  const originalKind = effectiveOriginalKind(detail.originalKind, detail.url);
  const contentLabel = formatRadarContentKind(originalKind, detail.sourceType, detail.url);
  const publishedLabel = formatRadarDetailDate(detail.publishedAt);
  const { lead, supportingExcerpt } = radarSummaryParts(detail);
  const tier = radarReadingTier(detail);
  const tierLabel = tier ? TIER_LABELS[tier] ?? tier : '待判断';
  const tags = cleanRadarTags(detail.tags);
  const points = (detail.highlights?.highlights ?? []).filter((point) => point.trim()).slice(0, 5);
  const displayTitle = decodeRadarTextEntities(detail.title);

  return (
    <Box
      data-radar-overview={variant}
      className={className}
      sx={{ minWidth: 0, overflowWrap: 'anywhere' }}
    >
      <Typography
        component="div"
        variant="metadata"
        color="text.secondary"
        sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: space.sm, rowGap: space.xs }}
      >
        <RadarSourceChip sourceType={detail.sourceType} sourceName={detail.sourceName} label={sourceName} />
        <Box component="span" aria-hidden>·</Box>
        <Box component="span">{contentLabel.short}</Box>
        {publishedLabel ? (
          <>
            <Box component="span" aria-hidden>·</Box>
            <Box component="span">发布 {publishedLabel}</Box>
          </>
        ) : null}
      </Typography>

      <Typography
        component={titleComponent}
        variant={isPage ? 'pageTitle' : 'panelTitle'}
        sx={{ mt: isPage ? 2 : space.md, maxWidth: isPage ? 960 : undefined }}
      >
        {displayTitle}
      </Typography>

      {detail.isAuthenticated ? (
        <Box sx={{ mt: isPage ? 2 : space.lg }}>
          <RadarFeedbackBar
            summaryId={detail.id}
            initialCounts={detail.feedbackCounts ?? emptyRadarFeedbackCounts()}
            initialMine={detail.myFeedbacks ?? []}
            types={OVERVIEW_FEEDBACK_TYPES}
          />
        </Box>
      ) : null}

      <Box
        sx={{
          mt: isPage ? 3 : space.lg,
          display: 'grid',
          gridTemplateColumns: isPage ? { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 240px' } : 'minmax(0, 1fr)',
          gap: isPage ? { xs: 3, lg: 4 } : space.lg,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ borderLeft: 2, borderColor: 'primary.main', pl: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Sparkles size={14} aria-hidden />
              <Typography component={sectionHeading} variant="fieldTitle">为什么值得看</Typography>
            </Box>
            <Typography variant="reading" component="p" sx={{ mt: 1, whiteSpace: 'pre-line' }}>
              {lead}
            </Typography>
            {points.length > 0 ? (
              <Box component="ul" sx={{ mt: 2, pl: 2.5, display: 'grid', gap: 0.75 }}>
                {points.map((point, index) => (
                  <Typography
                    key={`${index}-${point.slice(0, 16)}`}
                    component="li"
                    variant="body2"
                    color="text.secondary"
                    sx={{ whiteSpace: 'pre-line' }}
                  >
                    {point}
                  </Typography>
                ))}
              </Box>
            ) : null}
            {supportingExcerpt ? (
              <Box sx={{ mt: 2, borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
                <Typography
                  component="h3"
                  variant="metadata"
                  color="text.secondary"
                  sx={{ fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}
                >
                  原文补充
                </Typography>
                <Typography
                  variant="body2"
                  component="p"
                  color="text.secondary"
                  sx={{
                    mt: 1,
                    whiteSpace: 'pre-line',
                    ...(isPage
                      ? {}
                      : { display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
                  }}
                >
                  {supportingExcerpt}
                </Typography>
              </Box>
            ) : null}
            <Typography variant="metadata" component="p" color="text.secondary" sx={{ mt: 2 }}>
              {radarEvidenceNotice(detail)}
            </Typography>
          </Box>
        </Box>

        <Box
          role="group"
          aria-label="阅读等级与标签"
          sx={{
            minWidth: 0,
            borderColor: 'divider',
            borderTop: isPage ? 0 : 1,
            borderBottom: isPage ? { xs: 1, lg: 0 } : 0,
            borderLeft: isPage ? { lg: 1 } : 0,
            py: isPage ? { xs: 2, lg: 0 } : 2,
            pl: isPage ? { lg: 2.5 } : 0,
          }}
        >
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
            <Chip
              size="small"
              variant="outlined"
              label={tierLabel}
              sx={{ color: readingTierColor(tier), borderColor: 'currentColor', fontWeight: 600 }}
            />
            {tags.map((tag) => (
              <Chip key={tag} size="small" variant="outlined" label={`#${tag}`} color="default" />
            ))}
          </Box>

          {detail.distilledScore ? (
            <Accordion
              disableGutters
              square
              slots={{ heading: sectionHeading }}
              sx={{
                mt: 2,
                borderTop: 1,
                borderColor: 'divider',
                '&::before': { display: 'none' },
              }}
            >
              <AccordionSummary
                expandIcon={<ChevronDown size={16} aria-hidden />}
                sx={{
                  minHeight: 40,
                  px: 0,
                  '& .MuiAccordionSummary-content': { my: 1 },
                  '&.Mui-expanded': { minHeight: 40 },
                }}
              >
                <Typography variant="control" color="text.secondary">查看评分依据</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 0, pt: 0 }}>
                <DistilledScorePanel score={detail.distilledScore} effectiveTier={tier} embedded />
              </AccordionDetails>
            </Accordion>
          ) : null}
        </Box>
      </Box>

      <PreviousJudgments radarSummaryId={detail.id} enabled={Boolean(detail.isAuthenticated)} />

      {actions === 'inline' ? <RadarReadingActions detail={detail} variant={variant} /> : null}
      {children}
    </Box>
  );
}

export interface RadarReadingActionsProps {
  detail: ExternalReadingDetail;
  variant?: RadarReadingOverviewVariant;
}

/**
 * 共享操作区：写笔记 / 打开原文（唯一主 CTA） / Reader（次级） /
 * Zread（仓库才出现） / 深入调研。侧栏把它放在固定 footer，详情页内联。
 */
export function RadarReadingActions({ detail, variant = 'page' }: RadarReadingActionsProps) {
  const [platformOrigin, setPlatformOrigin] = React.useState<string | null>(null);
  const [sourcePromptOpen, setSourcePromptOpen] = React.useState(false);

  React.useEffect(() => {
    setPlatformOrigin(window.location.origin);
  }, []);

  const isPage = variant === 'page';
  const originalKind = effectiveOriginalKind(detail.originalKind, detail.url);
  const zreadUrl = originalKind === 'github_repo' ? zreadRepositoryUrl(detail.url) : null;
  const readerUrl = externalReaderUrl(detail.url, detail.id, platformOrigin);
  const sourceUrlAvailable = isHttpUrl(detail.url);
  const primaryLabel = zreadUrl ? '打开 GitHub' : '打开原文';

  const controls = (
    <>
      <RadarKnowledgeActions key={detail.id} detail={detail} />
      {sourceUrlAvailable ? (
        <AppButton
          component="a"
          variant="contained"
          href={detail.url}
          target="_blank"
          rel="noopener noreferrer"
          data-radar-primary-cta="true"
        >
          {zreadUrl ? <Github aria-hidden /> : <ExternalLink aria-hidden />}
          {primaryLabel}
        </AppButton>
      ) : null}
      {sourceUrlAvailable ? (
        // The installed extension intercepts this link; without it the link opens the store.
        <AppButton
          component="a"
          variant="outlined"
          color={isPage ? 'inherit' : 'primary'}
          href={READER_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-reader-launch-source={readerUrl}
          onClick={(event) => { event.preventDefault(); setSourcePromptOpen(true); }}
        >
          <BookOpenCheck aria-hidden />用 Reader 阅读
        </AppButton>
      ) : null}
      {zreadUrl ? (
        <AppButton
          component="a"
          variant="outlined"
          color={isPage ? 'inherit' : 'primary'}
          href={zreadUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink aria-hidden />打开 Zread
        </AppButton>
      ) : null}
      <AppButton
        component={Link}
        variant="outlined"
        color={isPage ? 'inherit' : 'primary'}
        href={`/ai-research?seed=${encodeURIComponent(detail.id)}`}
        prefetch={false}
      >
        <Sparkles aria-hidden />深入调研
      </AppButton>
    </>
  );

  if (!isPage) {
    return (
      <Box
        component="footer"
        aria-label="阅读操作"
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: space.sm,
          borderTop: 1,
          borderColor: 'divider',
          padding: space.lg,
          flexShrink: 0,
          '& > .MuiButton-root': { minWidth: 0, minHeight: 44, width: '100%' },
        }}
      >
        {controls}
        <ReaderSourcePrompt
          key={detail.id}
          open={sourcePromptOpen}
          onClose={() => setSourcePromptOpen(false)}
          readerUrl={readerUrl}
          sourceUrl={detail.url}
          articleTitle={detail.title}
        />
      </Box>
    );
  }

  return (
    <Box
      component="section"
      aria-label="阅读操作"
      sx={{ mt: 3, borderTop: 1, borderColor: 'divider', pt: 2 }}
    >
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
        {controls}
      </Box>
      {sourceUrlAvailable ? (
        <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 1 }}>
          在来源网站继续阅读、保存和同步；只有你明确保存时才会上传内容。
        </Typography>
      ) : null}
      <ReaderSourcePrompt
        key={detail.id}
        open={sourcePromptOpen}
        onClose={() => setSourcePromptOpen(false)}
        readerUrl={readerUrl}
        sourceUrl={detail.url}
        articleTitle={detail.title}
      />
    </Box>
  );
}
