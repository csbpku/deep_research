'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { AlertTriangle, CheckCircle2, CircleHelp } from 'lucide-react';
import type { ComparisonCell, ComparisonMatrix } from '@/lib/research-comparison-matrix';

const TONE = {
  evidence: { label: '有证据', color: 'var(--dr-color-success)', icon: CheckCircle2 },
  partial: { label: '部分', color: 'var(--dr-color-warning)', icon: AlertTriangle },
  unknown: { label: '未知', color: 'var(--dr-color-text-muted)', icon: CircleHelp },
  conflict: { label: '冲突', color: 'var(--dr-color-danger)', icon: AlertTriangle },
} as const;

function CellBody({ cell }: { cell: ComparisonCell }) {
  const tone = TONE[cell.status];
  const Icon = tone.icon;
  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5, color: tone.color }}>
        <Icon size={12} aria-hidden="true" />
        <Typography component="span" sx={{ fontSize: 'var(--dr-type-caption)', fontWeight: 600 }}>
          {tone.label}
        </Typography>
      </Box>
      <Box component="span" sx={{ fontSize: 'var(--dr-type-label)', lineHeight: 1.5 }}>{cell.text}</Box>
      {cell.citations.length > 0 && (
        <Box component="span" sx={{ display: 'block', mt: 0.5, color: 'var(--dr-color-primary)', fontSize: 'var(--dr-type-caption)' }}>
          {cell.citations.join(' ')}
        </Box>
      )}
    </>
  );
}

function Cell({ cell }: { cell: ComparisonCell }) {
  return (
    <Box component="td" data-status={cell.status} sx={{ minWidth: 180, verticalAlign: 'top' }}>
      <CellBody cell={cell} />
    </Box>
  );
}

export function ComparisonMatrixView({ matrix }: { matrix: ComparisonMatrix }) {
  const counts = matrix.rows.flatMap(row => row.cells).reduce<Record<string, number>>((acc, cell) => {
    acc[cell.status] = (acc[cell.status] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <Box data-testid="comparison-matrix">
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1.5, fontSize: 'var(--dr-type-caption)', color: 'var(--dr-color-text-muted)' }}>
        {(['evidence', 'partial', 'unknown', 'conflict'] as const).map(status => (
          counts[status] ? <span key={status}>{TONE[status].label} {counts[status]}</span> : null
        ))}
      </Box>
      <Box sx={{ display: { xs: 'grid', sm: 'block' }, gap: 1.5 }}>
        {matrix.rows.map(row => (
          <Box
            key={row.option}
            data-testid="comparison-matrix-card"
            component="section"
            aria-label={row.option}
            sx={{ display: { xs: 'block', sm: 'none' }, border: '1px solid var(--dr-color-outline)', borderRadius: 'var(--dr-radius-small)', p: 1.5 }}
          >
            <Typography component="h3" sx={{ fontSize: 'var(--dr-type-title-small)', fontWeight: 600, mb: 1 }}>
              {row.option}
            </Typography>
            <Box sx={{ display: 'grid', gap: 1.25 }}>
              {row.cells.map((cell, index) => (
                <Box key={`${row.option}-m-${index}`} data-status={cell.status}>
                  <Typography component="h4" sx={{ fontSize: 'var(--dr-type-caption)', fontWeight: 600, color: 'var(--dr-color-text-muted)', mb: 0.25 }}>
                    {matrix.dimensions[index] ?? `维度 ${index + 1}`}
                  </Typography>
                  <CellBody cell={cell} />
                </Box>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
      <Box sx={{ display: { xs: 'none', sm: 'block' }, overflowX: 'auto', border: '1px solid var(--dr-color-outline)', borderRadius: 'var(--dr-radius-small)' }} role="region" aria-label="对比矩阵，可横向滚动" tabIndex={0}>
        <Box component="table" sx={{ width: '100%', minWidth: 640, borderCollapse: 'collapse', fontSize: 'var(--dr-type-label)' }}>
          <Box component="thead">
            <Box component="tr">
              <Box component="th" scope="col" sx={{ position: 'sticky', left: 0, zIndex: 2, minWidth: 140, backgroundColor: 'var(--dr-color-surface-container)', p: 1.25, textAlign: 'left', borderBottom: '1px solid var(--dr-color-outline)' }}>
                方案
              </Box>
              {matrix.dimensions.map(dimension => (
                <Box component="th" scope="col" key={dimension} sx={{ minWidth: 180, backgroundColor: 'var(--dr-color-surface-container)', p: 1.25, textAlign: 'left', borderBottom: '1px solid var(--dr-color-outline)' }}>
                  {dimension}
                </Box>
              ))}
            </Box>
          </Box>
          <Box component="tbody">
            {matrix.rows.map(row => (
              <Box component="tr" key={row.option}>
                <Box component="th" scope="row" sx={{ position: 'sticky', left: 0, zIndex: 1, backgroundColor: 'var(--dr-color-surface)', p: 1.25, textAlign: 'left', verticalAlign: 'top', borderBottom: '1px solid var(--dr-color-outline)', fontWeight: 600 }}>
                  {row.option}
                </Box>
                {row.cells.map((cell, index) => (
                  <Cell key={`${row.option}-${index}`} cell={cell} />
                ))}
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
      <Typography sx={{ mt: 1, fontSize: 'var(--dr-type-caption)', color: 'var(--dr-color-text-muted)' }}>
        单元格只陈述证据支持的事实；“未知/冲突”是结论的一部分，不是缺口。
      </Typography>
    </Box>
  );
}
