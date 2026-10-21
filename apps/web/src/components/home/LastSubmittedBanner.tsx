'use client';

// 首页 / 父页通用的"刚提交的调研"提醒横幅。
// 数据来源:sessionStorage('ai-research:last-submitted:v1'),120s TTL。

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Rocket, X } from 'lucide-react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { space, tokens } from '@deep-research/design-system';

import { AppButton, AppIconButton } from '@/components/material/AppButton';
import {
  type LastSubmitted,
  clearLastSubmitted,
  readLastSubmitted,
} from '@/lib/last-submitted';

export function LastSubmittedBanner() {
  const [entry, setEntry] = useState<LastSubmitted | null>(null);

  useEffect(() => {
    setEntry(readLastSubmitted());
  }, []);

  if (!entry) return null;

  return (
    <Paper
      role="status"
      variant="outlined"
      sx={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.md,
        borderRadius: tokens['radius-small'], px: space.md, py: space.sm,
        bgcolor: 'background.paper', fontSize: tokens['type-body'], lineHeight: tokens['line-height-body'],
      }}
    >
      <Box component="span" sx={{ display: 'inline-flex', flexShrink: 0, color: 'text.secondary' }}>
        <Rocket aria-hidden="true" size={16} color="currentColor" />
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0, flex: 1 }}>
        刚提交的:<Box component="strong" sx={{ ml: space.xs, fontWeight: 500, color: 'text.primary', overflowWrap: 'anywhere' }}>{entry.topic}</Box>
      </Typography>
      <AppButton component={Link} href={`/ai-research/${entry.jobId}`} size="small" variant="outlined">
        查看进度
      </AppButton>
      <AppIconButton
        type="button"
        size="small"
        onClick={() => {
          clearLastSubmitted();
          setEntry(null);
        }}
        aria-label="关闭"
      >
        <X aria-hidden="true" />
      </AppIconButton>
    </Paper>
  );
}
