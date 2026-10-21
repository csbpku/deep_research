'use client';

import React, { useId, type ReactNode, type RefObject } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import { X } from 'lucide-react';

export function AppDialog({ open, onClose, title, description, children, actions, initialFocusRef }: {
  open: boolean; onClose: () => void; title: string; description?: ReactNode;
  children?: ReactNode; actions?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby={id} aria-describedby={description ? `${id}-description` : undefined} slotProps={{ paper: { className: 'material-surface' }, transition: { onEntered: () => initialFocusRef?.current?.focus() } }}>
      <DialogTitle id={`${id}-header`} component="div" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography id={id} component="h2" variant="panelTitle">{title}</Typography><IconButton aria-label={`关闭${title}`} onClick={onClose} sx={{ ml: 'auto' }}><X size={20} /></IconButton>
      </DialogTitle>
      <DialogContent>
        {description ? <DialogContentText id={`${id}-description`} sx={{ mb: 2 }}>{description}</DialogContentText> : null}
        {children}
      </DialogContent>
      {actions ? <DialogActions sx={{ p: 2 }}>{actions}</DialogActions> : null}
    </Dialog>
  );
}
