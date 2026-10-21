'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Flame, LayoutGrid, Library, Radar, Search, Settings, Workflow, type LucideIcon } from 'lucide-react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import { space, tokens } from '@deep-research/design-system';
import { AppButton } from '@/components/material/AppButton';
import { LinkPendingIcon } from '@/components/material/LinkPendingIcon';
import { isNavActive, PILL_LABELS, type NavItem, type NavItemIconKey } from './sidebar-nav-config';

export type { NavItem } from './sidebar-nav-config';
export { PRIMARY_NAV, ADMIN_NAV, PILL_LABELS, PLACEHOLDER_P1 } from './sidebar-nav-config';

const ICONS: Record<NavItemIconKey, LucideIcon> = { home: LayoutGrid, radar: Radar, research: Library, aiResearch: Workflow, search: Search, topic: Flame, admin: Settings };

export function SidebarNav({ items, onNavigate, collapsed = false, horizontal = false }: {
  items: NavItem[]; onNavigate?: () => void; collapsed?: boolean; horizontal?: boolean;
}) {
  const pathname = usePathname() ?? '/';
  return <Box component="nav" aria-label="主导航" sx={{ display: 'flex', gap: space.xs, flexDirection: horizontal ? 'row' : 'column' }}>
    {items.map(item => {
      const Icon = ICONS[item.icon];
      const active = isNavActive(pathname, item.href);
      const pill = PILL_LABELS[item.href];
      return <AppButton key={item.href} component={Link} href={item.href} onClick={onNavigate} aria-current={active ? 'page' : undefined} aria-label={collapsed ? item.label : undefined}
        title={collapsed ? item.label : undefined} sx={{
          justifyContent: horizontal || collapsed ? 'center' : 'flex-start', flexShrink: 0,
          padding: `${space.sm} ${space.md}`, gap: space.sm, borderRadius: tokens['radius-small'],
          color: active ? 'primary.main' : 'text.secondary', backgroundColor: active ? 'action.selected' : 'transparent',
          boxShadow: active ? (horizontal ? 'inset 0 -2px 0 var(--dr-color-primary)' : 'inset 2px 0 0 var(--dr-color-primary)') : 'none',
          '&:hover': { backgroundColor: active ? 'action.selected' : 'action.hover' },
        }}>
        <LinkPendingIcon label={item.label}><Icon size={16} aria-hidden /></LinkPendingIcon>{!collapsed ? item.label : null}
        {pill && !collapsed ? <Chip label={pill.label} size="small" sx={{ marginLeft: 'auto' }} /> : null}
      </AppButton>;
    })}
  </Box>;
}
