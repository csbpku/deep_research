'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { space } from '@deep-research/design-system';
import { AppButton } from '@/components/material/AppButton';

/** Preserve backend pagination, labels and the accessible nav contract. */
export function Pagination({ page, totalPages, onPageChange, disabled = false }: {
  page: number; totalPages: number; onPageChange: (next: number) => void; disabled?: boolean;
}) {
  if (totalPages <= 1) return null;
  return <Box component="nav" aria-label="分页" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: space.md, paddingBlock: space.lg }}>
    <AppButton type="button" variant="outlined" disabled={page <= 1 || disabled} onClick={() => onPageChange(Math.max(1, page - 1))}><ChevronLeft aria-hidden />上一页</AppButton>
    <Typography variant="metadata" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>第 {page} / {totalPages} 页</Typography>
    <AppButton type="button" variant="outlined" disabled={page >= totalPages || disabled} onClick={() => onPageChange(Math.min(totalPages, page + 1))}>下一页<ChevronRight aria-hidden /></AppButton>
  </Box>;
}
