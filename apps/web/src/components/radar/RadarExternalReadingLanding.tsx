'use client';

import Link from 'next/link';
import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { AppButton } from '@/components/material/AppButton';
import { BackToSearchButton } from '../domain/BackToSearchButton';
import { RadarReadingOverview } from './RadarReadingOverview';
import type { ExternalReadingDetail } from './radar-reading-detail';

// Re-exported for existing imports. The definitions live in
// `radar-reading-detail.ts` so the preview panel and the detail page share one
// contract without importing this page shell.
export {
  cleanRadarTags,
  externalReaderUrl,
  formatRadarDetailDate,
  radarReadingTier,
  radarSummaryParts,
} from './radar-reading-detail';
export type { ExternalReadingDetail } from './radar-reading-detail';

/**
 * Full-page shell for `/radar/[id]`.
 *
 * Only the page chrome lives here: scroll container, back navigation and the
 * 1280px article column. Every reading field and every action comes from
 * `RadarReadingOverview`, which is also what the side preview renders — the two
 * surfaces cannot drift apart.
 */
export function RadarExternalReadingLanding({
  detail,
  backHref = '/radar',
}: {
  detail: ExternalReadingDetail;
  backHref?: string;
}) {
  return (
    <Box
      data-radar-knowledge-id={detail.id}
      sx={{
        display: 'flex',
        minHeight: 0,
        flex: 1,
        flexDirection: 'column',
        overflowY: 'auto',
        overflowWrap: 'anywhere',
        bgcolor: 'background.default',
      }}
    >
      <Box
        component="header"
        sx={{
          display: 'flex',
          flexWrap: { xs: 'wrap', sm: 'nowrap' },
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.5,
          position: 'sticky',
          top: 0,
          zIndex: 20,
          minHeight: 48,
          py: { xs: 1, sm: 0 },
          px: { xs: 2, sm: 3 },
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <BackToSearchButton />
          <AppButton
            component={Link}
            href={backHref}
            variant="text"
            color="inherit"
            aria-label="回到雷达"
            startIcon={<span aria-hidden>←</span>}
          >
            <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>回到雷达</Box>
            <Box component="span" sx={{ display: { xs: 'inline', sm: 'none' } }}>雷达</Box>
          </AppButton>
          <Typography
            variant="metadata"
            color="text.secondary"
            sx={{ display: { xs: 'none', sm: 'inline' } }}
          >
            文章概览
          </Typography>
        </Box>
      </Box>

      <Box
        component="article"
        data-testid="radar-detail"
        sx={{
          mx: 'auto',
          width: '100%',
          maxWidth: 1280,
          px: { xs: 2, sm: 3, md: 4 },
          py: { xs: 3, sm: 4 },
        }}
      >
        <Box sx={{ maxWidth: 1080 }}>
          <RadarReadingOverview detail={detail} variant="page" />
        </Box>
      </Box>
    </Box>
  );
}
