'use client';

import Link from 'next/link';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookOpen, ExternalLink, Github, Sparkles, X } from 'lucide-react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import { space, tokens } from '@deep-research/design-system';
import { AppButton, AppIconButton } from '@/components/material/AppButton';

import { DistilledScorePanel } from './DistilledScorePanel';
import {
  cleanRadarTags,
  externalReaderUrl,
  formatRadarDetailDate,
  radarSummaryParts,
  type ExternalReadingDetail,
} from './RadarExternalReadingLanding';
import { formatRadarContentKind, formatSourceType } from '@/lib/radar/source-labels';
import { TIER_LABELS, readingTierColor } from '@/components/domain/ScoreBar';
import { effectiveOriginalKind, zreadRepositoryUrl } from './radar-repository';
import { RadarSourceChip } from './RadarSourceChip';
import { PreviousJudgments, RadarKnowledgeActions } from './RadarKnowledgeActions';
import { ReaderSourcePrompt } from './ReaderSourcePrompt';

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
  className,
}: {
  detail: ExternalReadingDetail;
  onClose: () => void;
  className?: string;
}) {
  const [platformOrigin, setPlatformOrigin] = useState<string | null>(null);
  const [sourcePromptOpen, setSourcePromptOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const scrollPort = panel?.closest<HTMLElement>('#main-content');
    // The mobile drawer is already bounded by its fixed viewport container.
    if (!panel || !scrollPort) return;
    let frame = 0;
    let revealControls = true;
    const update = () => {
      frame = 0;
      if (!panel.getClientRects().length) return;
      const viewport = window.visualViewport;
      const portBounds = scrollPort.getBoundingClientRect();
      const bottom = Math.min(
        (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
        portBounds.bottom,
      );
      const panelStyle = getComputedStyle(panel);
      const bodyStyle = scrollContainerRef.current ? getComputedStyle(scrollContainerRef.current) : null;
      const spacing = Number.parseFloat(panelStyle.getPropertyValue('--dr-space-4')) || 16;
      const gap = Math.max(spacing, Number.parseFloat(getComputedStyle(scrollPort).paddingBottom) || 0);
      const available = () => Math.max(0, Math.floor(bottom - Math.max(panel.getBoundingClientRect().top, portBounds.top) - gap));
      const controlsHeight = (panel.querySelector<HTMLElement>('header')?.offsetHeight ?? 0)
        + (panel.querySelector<HTMLElement>('footer')?.offsetHeight ?? 0)
        + (Number.parseFloat(bodyStyle?.paddingTop ?? '') || 0)
        + (Number.parseFloat(bodyStyle?.paddingBottom ?? '') || 0)
        + (Number.parseFloat(panelStyle.borderTopWidth) || 0)
        + (Number.parseFloat(panelStyle.borderBottomWidth) || 0);
      if (available() < controlsHeight) {
        // In a very short window, move only enough to fit the controls and a
        // small reading area; do not force the user to the end of the list.
        const minimum = Math.min(controlsHeight + (revealControls ? spacing * 4 : 0), bottom - portBounds.top - gap);
        scrollPort.scrollTop += Math.max(0, minimum - available());
      }
      revealControls = false;
      const height = `${available()}px`;
      if (panel.style.getPropertyValue('--radar-preview-available-height') !== height) {
        panel.style.setProperty('--radar-preview-available-height', height);
      }
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const resize = () => {
      revealControls = true;
      schedule();
    };
    update();
    const observer = new ResizeObserver(entries => {
      if (entries.some(entry => entry.target === scrollPort)) revealControls = true;
      schedule();
    });
    observer.observe(scrollPort);
    observer.observe(panel);
    for (const controls of panel.querySelectorAll(':scope > header, :scope > footer')) observer.observe(controls);
    window.addEventListener('resize', resize);
    scrollPort.addEventListener('scroll', schedule, { passive: true });
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      scrollPort.removeEventListener('scroll', schedule);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, []);

  useEffect(() => {
    setPlatformOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [detail.id]);

  const sourceLabel = formatSourceType(detail.sourceType);
  const sourceName = detail.sourceName?.trim() || sourceLabel.short;
  const originalKind = effectiveOriginalKind(detail.originalKind, detail.url);
  const contentLabel = formatRadarContentKind(originalKind, detail.sourceType, detail.url);
  const publishedLabel = formatRadarDetailDate(detail.publishedAt);
  const { lead, supportingExcerpt } = radarSummaryParts(detail);
  const tier = detail.tier ?? detail.distilledScore?.tier ?? null;
  const tierLabel = tier ? (TIER_LABELS[tier] ?? tier) : '待判断';
  const tags = cleanRadarTags(detail.tags);
  const sourceUrlAvailable = isHttpUrl(detail.url);
  const zreadUrl = originalKind === 'github_repo'
    ? zreadRepositoryUrl(detail.url)
    : null;
  const readerUrl = externalReaderUrl(detail.url, detail.id, platformOrigin);

  return (
    <Box ref={panelRef} component="aside" data-radar-knowledge-id={detail.id} className={className} aria-label="文章概览" sx={{
      display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden',
      overflowWrap: 'anywhere',
      border: 1, borderColor: 'divider', borderRadius: tokens['radius-medium'], bgcolor: 'background.paper',
      maxHeight: { xs: '90dvh', lg: 'var(--radar-preview-available-height, calc(100dvh - 8rem))' },
    }}>
      <Box component="header" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.md, borderBottom: 1, borderColor: 'divider', padding: space.lg, flexShrink: 0 }}>
        <Typography variant="control" color="primary" sx={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
          <Sparkles size={16} aria-hidden />文章概览
        </Typography>
        <AppIconButton type="button" onClick={onClose} aria-label="关闭预览" title="关闭预览"><X size={18} aria-hidden /></AppIconButton>
      </Box>
      <Box ref={scrollContainerRef} data-radar-preview-body sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehaviorY: 'contain', padding: space.lg }}>
        <Typography component="div" variant="metadata" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: space.sm, rowGap: space.xs }}>
          <RadarSourceChip sourceType={detail.sourceType} sourceName={detail.sourceName} label={sourceName} /><span aria-hidden>·</span><span>{contentLabel.short}</span>
          {publishedLabel ? <><span aria-hidden>·</span><span>发布 {publishedLabel}</span></> : null}
        </Typography>
        <Typography component="h2" variant="panelTitle" sx={{ marginTop: space.md, overflowWrap: 'anywhere' }}>{detail.title}</Typography>
        <Box component="section" aria-labelledby="radar-preview-summary" sx={{ marginTop: space.section, borderLeft: 2, borderColor: 'primary.main', paddingLeft: space.md }}>
          <Typography component="h3" id="radar-preview-summary" variant="fieldTitle">AI 摘要</Typography>
          <Typography component="p" variant="metadata" color="text.secondary" sx={{ marginTop: space.xs }}>
            同步时临时读取原文生成摘要和评分；全文不保存在本站。阅读请打开原文或 Reader。
          </Typography>
          <Typography component="p" variant="reading" sx={{ marginTop: space.sm, whiteSpace: 'pre-line' }}>{lead}</Typography>
          {supportingExcerpt ? (
            <Box sx={{ marginTop: space.md, paddingTop: space.md, borderTop: 1, borderColor: 'divider' }}>
              <Typography component="h3" variant="fieldTitle">原文补充</Typography>
              <Typography component="p" variant="reading" color="text.secondary" sx={{ marginTop: space.sm, display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-line' }}>{supportingExcerpt}</Typography>
            </Box>
          ) : null}
        </Box>
        {detail.selectionReason?.trim() ? (
          <Box component="section" sx={{ marginTop: space.section, paddingTop: space.lg, borderTop: 1, borderColor: 'divider' }}>
            <Typography component="h3" variant="fieldTitle">为什么值得看</Typography>
            <Typography component="p" variant="reading" color="text.secondary" sx={{ marginTop: space.sm }}>{detail.selectionReason.trim()}</Typography>
          </Box>
        ) : null}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, marginTop: space.lg, paddingTop: space.md, borderTop: 1, borderColor: 'divider' }}>
          <Chip size="small" variant="outlined" label={tierLabel} sx={{ color: readingTierColor(tier), borderColor: 'currentColor' }} />
          {tags.map(tag => <Chip key={tag} size="small" variant="outlined" label={`#${tag}`} />)}
        </Box>
        <PreviousJudgments radarSummaryId={detail.id} enabled={Boolean(detail.isAuthenticated)} />
        {detail.distilledScore ? (
          <Box component="details" sx={{ marginTop: space.lg, paddingTop: space.md, borderTop: 1, borderColor: 'divider' }}>
            <Typography component="summary" variant="control" sx={{ cursor: 'pointer', color: 'text.secondary' }}>查看评分依据</Typography>
            <Box sx={{ paddingTop: space.md }}><DistilledScorePanel score={detail.distilledScore} effectiveTier={tier} embedded /></Box>
          </Box>
        ) : null}
      </Box>
      <Box component="footer" sx={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, borderTop: 1, borderColor: 'divider', padding: space.lg, flexShrink: 0 }}>
        <RadarKnowledgeActions key={detail.id} detail={detail} />
        {sourceUrlAvailable ? (
          <AppButton type="button" variant="contained" onClick={() => setSourcePromptOpen(true)} sx={{ flex: '1 0 auto' }}>
            {zreadUrl ? <Github aria-hidden /> : <ExternalLink aria-hidden />}{zreadUrl ? '打开 GitHub' : '打开原文'}
          </AppButton>
        ) : null}
        {zreadUrl ? (
          <AppButton component="a" variant="outlined" href={zreadUrl} target="_blank" rel="noopener noreferrer" sx={{ flex: '1 0 auto' }}><BookOpen aria-hidden />打开 Zread</AppButton>
        ) : null}
        <AppButton component={Link} href={`/ai-research?seed=${encodeURIComponent(detail.id)}`} prefetch={false} variant="outlined" sx={{ flex: '1 0 auto' }}><Sparkles aria-hidden />深入调研</AppButton>
      </Box>
      <ReaderSourcePrompt key={detail.id} open={sourcePromptOpen} onClose={() => setSourcePromptOpen(false)} readerUrl={readerUrl} />
    </Box>
  );
}
