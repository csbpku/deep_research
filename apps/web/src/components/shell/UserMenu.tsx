'use client';

import * as React from 'react';
import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { Bookmark, Bell, ChevronDown, FilePenLine, LogIn, LogOut, Pin, Settings, ShieldCheck } from 'lucide-react';
import Avatar from '@mui/material/Avatar';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { space } from '@deep-research/design-system';
import { AppButton } from '@/components/material/AppButton';
import { researchTabHref } from '@/lib/research-tabs';

export type ShellUser = { email: string; name: string; image: string | null; role: 'member' | 'admin' } | null;

/** Auth and role checks stay in AppShell; this island only renders the menu. */
export function UserMenu({ user }: { user: ShellUser }) {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const id = React.useId();
  if (!user) return <AppButton component={Link} href="/signin" variant="contained" startIcon={<LogIn aria-hidden />}>登录</AppButton>;

  const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
  const close = () => setAnchor(null);
  const links = [
    { href: researchTabHref('draft'), label: '我的草稿', icon: FilePenLine },
    { href: '/me?tab=bookmarks', label: '我的收藏', icon: Bookmark },
    { href: '/me/topics', label: '我的主题关注', icon: Pin },
    { href: '/me?tab=notifications', label: '我的通知', icon: Bell },
    { href: '/me?tab=preferences', label: '个人设置', icon: Settings },
  ];
  return <>
    <AppButton id={`${id}-trigger`} aria-label="打开用户菜单" aria-haspopup="menu" aria-expanded={Boolean(anchor)} aria-controls={anchor ? id : undefined}
      onClick={event => setAnchor(event.currentTarget)} sx={{ padding: space.xs, color: 'text.secondary' }}>
      <Avatar src={user.image ?? undefined} alt="" sx={{ width: '28px', height: '28px', fontSize: 'inherit', bgcolor: 'action.selected', color: 'primary.main' }}>{initial}</Avatar>
      <ChevronDown size={14} aria-hidden />
    </AppButton>
    <Menu id={id} anchorEl={anchor} open={Boolean(anchor)} onClose={close}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { className: 'material-surface', sx: { width: '256px', maxWidth: 'calc(100vw - 32px)' } }, list: { 'aria-labelledby': `${id}-trigger` } }}>
      <ListSubheader role="presentation" disableSticky sx={{ lineHeight: 'inherit', padding: space.md, bgcolor: 'transparent' }}>
        <Typography variant="fieldTitle" component="p" sx={{ overflowWrap: 'anywhere' }}>{user.name || user.email}</Typography>
        <Typography variant="metadata" component="p" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{user.email}</Typography>
      </ListSubheader>
      <Divider />
      <ListSubheader role="presentation" disableSticky sx={{ typography: 'metadata', bgcolor: 'transparent', paddingBlock: space.sm }}>我的内容</ListSubheader>
      {links.map(item => <MenuItem key={item.href} component={Link} href={item.href} onClick={close}>
        <ListItemIcon><item.icon size={16} aria-hidden /></ListItemIcon>{item.label}
      </MenuItem>)}
      {user.role === 'admin' ? <MenuItem component={Link} href="/admin" onClick={close} sx={{ borderTop: 1, borderColor: 'divider' }}><ListItemIcon><ShieldCheck size={16} aria-hidden /></ListItemIcon>Admin 控制台</MenuItem> : null}
      <Divider />
      <MenuItem onClick={() => { close(); void signOut({ callbackUrl: '/signin' }); }}><ListItemIcon><LogOut size={16} aria-hidden /></ListItemIcon>登出</MenuItem>
    </Menu>
  </>;
}
