'use client';

import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { Sparkles, X } from 'lucide-react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { space, tokens } from '@deep-research/design-system';
import { AppIconButton } from '@/components/material/AppButton';

import { RadarReadingActions, RadarReadingOverview } from './RadarReadingOverview';
import type { ExternalReadingDetail } from './radar-reading-detail';

/**
 * 雷达列表右侧的阅读概览面板。
 *
 * 内容全部来自 `RadarReadingOverview`，这里只保留面板外壳：尺寸约束、
 * 滚动容器、关闭按钮，以及固定在底部的操作区（避免在嵌套滚动容器里再套
 * 一层滚动）。操作区由共享组件渲染，因此预览与详情页的 CTA 集合一致。
 */
export function RadarPreviewPanel({
  detail,
  onClose,
  className,
  panelRef: panelRefProp,
}: {
  detail: ExternalReadingDetail;
  onClose: () => void;
  className?: string;
  /** 父级用它做焦点交接（打开时聚焦标题，关闭时还焦点）。 */
  panelRef?: React.RefObject<HTMLElement | null>;
}) {
  const localPanelRef = useRef<HTMLElement>(null);
  const panelRef = panelRefProp ?? localPanelRef;
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
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [detail.id]);

  return (
    <Box
      ref={panelRef ?? localPanelRef}
      component="aside"
      data-radar-knowledge-id={detail.id}
      className={className}
      aria-label="文章概览"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        overflowWrap: 'anywhere',
        border: 1,
        borderColor: 'divider',
        borderRadius: tokens['radius-medium'],
        bgcolor: 'background.paper',
        maxHeight: { xs: '90dvh', lg: 'var(--radar-preview-available-height, calc(100dvh - 8rem))' },
      }}
    >
      <Box
        component="header"
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: space.md,
          borderBottom: 1,
          borderColor: 'divider',
          padding: space.lg,
          flexShrink: 0,
        }}
      >
        <Typography variant="control" color="primary" sx={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
          <Sparkles size={16} aria-hidden />文章概览
        </Typography>
        <AppIconButton type="button" onClick={onClose} aria-label="关闭预览" title="关闭预览">
          <X size={18} aria-hidden />
        </AppIconButton>
      </Box>
      <Box
        ref={scrollContainerRef}
        data-radar-preview-body
        sx={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehaviorY: 'contain',
          padding: space.lg,
        }}
      >
        <RadarReadingOverview detail={detail} variant="panel" actions="none" />
      </Box>
      <RadarReadingActions detail={detail} variant="panel" />
    </Box>
  );
}
