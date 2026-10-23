import * as React from 'react';

import Box, { type BoxProps } from '@mui/material/Box';

/**
 * MetaRow —— 详情页的「作者 · 日期 · 计数」元信息行。
 * 迁移前 researches/[id]、summaries/[id]、radar/[id] 各写了一遍。
 */
export function MetaRow({
  className,
  children,
  sx,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & Pick<BoxProps<'div'>, 'sx'>) {
  return (
    <Box
      component="div"
      className={className}
      sx={[
        {
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          columnGap: 'var(--dr-space-3)',
          rowGap: 'var(--dr-space-1)',
          color: 'text.secondary',
          typography: 'metadata',
          '& svg': { width: 14, height: 14, flexShrink: 0 },
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
      {...props}
    >
      {children}
    </Box>
  );
}

/** 单项元信息：可选图标 + 文本。多项之间由 MetaRow 的 gap 分隔。 */
export function MetaItem({
  icon,
  children,
  mono = false,
  className,
  sx,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  /** ID / 数值类用等宽字体 */
  mono?: boolean;
  className?: string;
  sx?: BoxProps<'span'>['sx'];
}) {
  return (
    <Box
      component="span"
      className={className}
      sx={[
        {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--dr-space-1)',
          ...(mono ? { fontFamily: 'monospace' } : {}),
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {icon}
      {children}
    </Box>
  );
}
