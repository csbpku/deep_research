'use client';

import Link from 'next/link';
import React, { useEffect, useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
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
import { RadarSourceChip } from './RadarSourceChip';
import {
  formatRadarContentKind,
  formatSourceType,
} from '../../lib/radar/source-labels';
import { TIER_LABELS, readingTierColor } from '../domain/ScoreBar';
import { AppButton } from '@/components/material/AppButton';
import { isReaderPromptDismissed } from '@/lib/reader-install';
import { effectiveOriginalKind, zreadRepositoryUrl } from './radar-repository';
import { PreviousJudgments, RadarKnowledgeActions } from './RadarKnowledgeActions';
import { ReaderSourcePrompt } from './ReaderSourcePrompt';

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
      'external_reading',
      'content_pending',
      'fetch_failed_shell',
      'paywall_stub',
    ].includes(tag);
  }).slice(0, 4);
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
  const [readerPromptDismissed, setReaderPromptDismissed] = useState(false);

  useEffect(() => {
    setPlatformOrigin(window.location.origin);
    setReaderPromptDismissed(isReaderPromptDismissed());
  }, []);

  const sourceLabel = formatSourceType(detail.sourceType);
  const sourceName = detail.sourceName?.trim() || sourceLabel.short;
  const originalKind = effectiveOriginalKind(detail.originalKind, detail.url);
  const contentLabel = formatRadarContentKind(originalKind, detail.sourceType, detail.url);
  const readerUrl = externalReaderUrl(detail.url, detail.id, platformOrigin);
  const sourceUrlAvailable = isHttpUrl(detail.url);
  const zreadUrl = originalKind === 'github_repo'
    ? zreadRepositoryUrl(detail.url)
    : null;
  const tier = detail.tier ?? detail.distilledScore?.tier ?? null;
  const tierLabel = tier ? (TIER_LABELS[tier] ?? tier) : '待判断';
  const { lead: summaryLead, supportingExcerpt } = radarSummaryParts(detail);
  const tags = cleanRadarTags(detail.tags);
  const publishedLabel = formatRadarDetailDate(detail.publishedAt);
  const displayTitle = decodeRadarTextEntities(detail.title);

  return (
    <Box data-radar-knowledge-id={detail.id} sx={{ display: 'flex', minHeight: 0, flex: 1, flexDirection: 'column', overflowY: 'auto', overflowWrap: 'anywhere', bgcolor: 'background.default' }}>
      <Box component="header" sx={{ display: 'flex', flexWrap: { xs: 'wrap', sm: 'nowrap' }, alignItems: 'center', justifyContent: 'space-between', gap: 1.5, position: 'sticky', top: 0, zIndex: 20, minHeight: 48, py: { xs: 1, sm: 0 }, px: { xs: 2, sm: 3 }, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <BackToSearchButton />
          <AppButton component={Link} href={backHref} variant="text" color="inherit" aria-label="回到雷达" startIcon={<span aria-hidden>←</span>}>
            <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>回到雷达</Box>
            <Box component="span" sx={{ display: { xs: 'inline', sm: 'none' } }}>雷达</Box>
          </AppButton>
          <Typography variant="metadata" color="text.secondary" sx={{ display: { xs: 'none', sm: 'inline' } }}>文章概览</Typography>
        </Box>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 1, flexShrink: 0, maxWidth: '100%' }}>
          <RadarKnowledgeActions key={detail.id} detail={detail} />
          {sourceUrlAvailable ? (
            <AppButton
              component="a" variant="contained"
              href={detail.url} target="_blank" rel="noopener noreferrer"
              startIcon={zreadUrl ? <Github aria-hidden /> : <ExternalLink aria-hidden />}
            >
              <span>{zreadUrl ? '打开 GitHub' : '打开原文'}</span>
            </AppButton>
          ) : null}
          {sourceUrlAvailable ? (
            // Reader 是可选增强：装了扩展开侧栏，没装就是普通外链。
            <AppButton
              component="a" variant="outlined" color="inherit"
              href={readerUrl} target="_blank" rel="noopener noreferrer"
              data-reader-launch-source={readerUrl}
              startIcon={<BookOpenCheck aria-hidden />}
            >
              <span>用 Reader 阅读</span>
            </AppButton>
          ) : null}
          {zreadUrl ? (
            <AppButton component="a" href={zreadUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="outlined" color="inherit" startIcon={<BookOpen aria-hidden />}
            >
              <span>打开 Zread</span>
            </AppButton>
          ) : null}
        </Box>
      </Box>

      <Box component="article" data-testid="radar-detail" sx={{ mx: 'auto', width: '100%', maxWidth: 1280, px: { xs: 2, sm: 3, md: 4 }, py: { xs: 3, sm: 4 } }}>
        <Box component="section" sx={{ maxWidth: 1080 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 }}>
            <RadarSourceChip sourceType={detail.sourceType} sourceName={detail.sourceName} label={sourceName} />
            <Typography aria-hidden variant="metadata" color="text.secondary">·</Typography>
            <Typography variant="metadata" color="text.secondary" sx={{ fontWeight: 600 }}>{contentLabel.short}</Typography>
            {publishedLabel ? (
              <>
                <Typography aria-hidden variant="metadata" color="text.secondary">·</Typography>
                <Typography variant="metadata" color="text.secondary">发布 {publishedLabel}</Typography>
              </>
            ) : null}
          </Box>

          <Typography variant="pageTitle" component="h1" sx={{ mt: 2, maxWidth: 960, overflowWrap: 'anywhere' }}>
            {displayTitle}
          </Typography>

          <Box sx={{ mt: 3, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 240px' }, gap: { xs: 3, lg: 4 } }}>
            <Box sx={{ minWidth: 0 }}>
              <Box sx={{ borderLeft: 2, borderColor: 'primary.main', pl: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Sparkles size={14} aria-hidden />
                  <Typography variant="metadata" color="primary.main" sx={{ fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    为什么值得看
                  </Typography>
                </Box>
                <Typography variant="reading" component="p" sx={{ mt: 1, whiteSpace: 'pre-line' }}>
                  {summaryLead}
                </Typography>
                {supportingExcerpt ? (
                  <Box sx={{ mt: 2, borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
                    <Typography variant="metadata" color="text.secondary" sx={{ fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      原文补充
                    </Typography>
                    <Typography variant="body2" component="p" color="text.secondary" sx={{ mt: 1, whiteSpace: 'pre-line' }}>
                      {supportingExcerpt}
                    </Typography>
                  </Box>
                ) : null}
                <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
                  同步时临时读取原文生成摘要和评分；全文不保存在本站。阅读请打开原文或 Reader。
                </Typography>
              </Box>
            </Box>

            <Box component="aside" sx={{ minWidth: 0, borderBlock: { xs: 1, lg: 0 }, borderColor: 'divider', py: { xs: 2, lg: 0 }, pl: { lg: 2.5 }, borderLeft: { lg: 1 } }}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
                <Chip size="small" variant="outlined" label={tierLabel}
                  sx={{ color: readingTierColor(tier), borderColor: 'currentColor', fontWeight: 600 }} />
                {tags.length > 0 ? (
                  tags.map((tag) => <Chip key={tag} size="small" variant="outlined" label={`#${tag}`} color="default" />)
                ) : null}
              </Box>

              {detail.distilledScore ? (
                <Accordion disableGutters square slots={{ heading: 'h2' }} sx={{ mt: 2, borderTop: 1, borderColor: 'divider', '&::before': { display: 'none' } }}>
                  <AccordionSummary expandIcon={<ChevronDown size={16} aria-hidden />}
                    sx={{ minHeight: 40, px: 0, '& .MuiAccordionSummary-content': { my: 1 }, '&.Mui-expanded': { minHeight: 40 } }}>
                    <Typography variant="control" color="text.secondary">查看评分依据</Typography>
                  </AccordionSummary>
                  <AccordionDetails sx={{ px: 0, pt: 0 }}>
                    <DistilledScorePanel score={detail.distilledScore} effectiveTier={tier} embedded />
                  </AccordionDetails>
                </Accordion>
              ) : null}
            </Box>
          </Box>
        </Box>

        <PreviousJudgments radarSummaryId={detail.id} enabled={Boolean(detail.isAuthenticated)} />
        <Box component="section" id="source-reading" sx={{ mt: 4, borderTop: 1, borderColor: 'divider', pt: 2 }}>
          <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { sm: 'center' }, justifyContent: 'space-between', gap: 2 }}>
            <Box sx={{ maxWidth: 640 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <BookOpenCheck size={16} aria-hidden />
                <Typography variant="metadata" color="primary.main" sx={{ fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Reader</Typography>
              </Box>
              <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 0.5 }}>
                在来源网站继续阅读、保存和同步；只有你明确保存时才会上传内容。
              </Typography>
            </Box>
            {readerPromptDismissed ? (
              <AppButton
                component="a" href={readerUrl} target="_blank" rel="noopener noreferrer"
                variant="outlined" color="inherit" startIcon={<BookOpenCheck aria-hidden />}
                data-reader-launch-source={readerUrl}
              >
                <span>用 Reader 阅读</span>
              </AppButton>
            ) : (
              <AppButton type="button" onClick={() => setSourcePromptOpen(true)} variant="outlined" color="inherit" startIcon={<BookOpenCheck aria-hidden />}>
                安装 Reader
              </AppButton>
            )}
          </Box>
        </Box>
      </Box>
      <ReaderSourcePrompt
        key={detail.id}
        open={sourcePromptOpen}
        onClose={() => {
          setSourcePromptOpen(false);
          setReaderPromptDismissed(isReaderPromptDismissed());
        }}
        readerUrl={readerUrl}
      />
    </Box>
  );
}
