'use client';

import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';

/** dr-theme remains the only persisted mode, including the system preference. */
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const id = React.useId();
  React.useEffect(() => setMounted(true), []);

  // Reserve the same hit area on the server to avoid a layout shift.
  if (!mounted) return <Box aria-hidden sx={{ width: '36px', height: '36px', '@media (pointer: coarse)': { width: '44px', height: '44px' } }} />;

  return <>
    <IconButton id={`${id}-trigger`} aria-label="切换主题" aria-haspopup="menu" aria-expanded={Boolean(anchor)} aria-controls={anchor ? id : undefined} onClick={event => setAnchor(event.currentTarget)}>
      {resolvedTheme === 'dark' ? <Moon size={18} aria-hidden /> : <Sun size={18} aria-hidden />}
    </IconButton>
    <Menu id={id} anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { className: 'material-surface' }, list: { 'aria-labelledby': `${id}-trigger` } }}>
      {([{ value: 'light', label: '浅色', icon: Sun }, { value: 'dark', label: '深色', icon: Moon }, { value: 'system', label: '跟随系统', icon: Monitor }] as const).map(option => (
        <MenuItem key={option.value} role="menuitemradio" aria-checked={theme === option.value} selected={theme === option.value} onClick={() => { setTheme(option.value); setAnchor(null); }}>
          <ListItemIcon><option.icon size={16} aria-hidden /></ListItemIcon>{option.label}
        </MenuItem>
      ))}
    </Menu>
  </>;
}
