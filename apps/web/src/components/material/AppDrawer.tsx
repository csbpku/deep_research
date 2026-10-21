'use client';

import React, { useId, type ReactNode } from 'react';
import Drawer, { type DrawerProps } from '@mui/material/Drawer';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import { X } from 'lucide-react';
import { space, tokens } from '@deep-research/design-system';

export function AppDrawer({ open, onClose, title, description, children, anchor = 'right', hideHeader = false, width }: {
  open: boolean; onClose: () => void; title: string; description?: string;
  children: ReactNode; anchor?: DrawerProps['anchor']; hideHeader?: boolean; width?: string;
}) {
  const id = useId();
  return (
    <Drawer open={open} anchor={anchor} onClose={onClose} slotProps={{ paper: {
      className: 'material-surface', role: 'dialog', 'aria-modal': true, 'aria-labelledby': id,
      'aria-describedby': description ? `${id}-description` : undefined,
      sx: { width: width ?? (anchor === 'bottom' ? '100%' : { xs: '100%', sm: '420px' }), maxWidth: '100vw', maxHeight: anchor === 'bottom' ? '90dvh' : '100dvh', borderRadius: anchor === 'bottom' ? `${tokens['radius-medium']} ${tokens['radius-medium']} 0 0` : 0 },
    } }}>
      {hideHeader ? <Typography id={id} component="h2" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>{title}</Typography> : (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: space.sm, padding: space.lg, borderBottom: 1, borderColor: 'divider' }}>
          <Typography id={id} component="h2" variant="panelTitle" sx={{ flex: 1 }}>{title}</Typography>
          <IconButton aria-label={`关闭${title}`} onClick={onClose}><X size={20} /></IconButton>
        </Box>
      )}
      {description ? <Typography id={`${id}-description`} variant="body2" color="text.secondary" sx={{ padding: space.lg, paddingBottom: 0 }}>{description}</Typography> : null}
      {children}
    </Drawer>
  );
}
