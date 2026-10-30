'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Menu as MenuIcon, Search as SearchIcon } from 'lucide-react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { space } from '@deep-research/design-system';
import { AppButton } from '@/components/material/AppButton';
import { AppDrawer } from '@/components/material/AppDrawer';
import { BrandMark } from './BrandMark';
import { SidebarNav, type NavItem } from './SidebarNav';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu, type ShellUser } from './UserMenu';

interface AiJobsResponse {
  total: number;
  items: Array<{ jobId: string; topic: string; status: string; currentStep: string | null; finalStatus: string | null }>;
}

/** The query and destinations are unchanged; MUI owns focus and popup stacking. */
function AiResearchIndicator() {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const id = React.useId();
  const { data } = useQuery<AiJobsResponse>({
    queryKey: ['topbar', 'ai-research', 'in-flight'],
    queryFn: async () => {
      const response = await fetch('/api/ai-research/jobs?status=queued,running&limit=5', { cache: 'no-store' });
      return response.ok ? response.json() : { total: 0, items: [] };
    },
    refetchInterval: 15_000, staleTime: 10_000, refetchOnWindowFocus: false,
  });
  const jobs = data?.items ?? [];
  const count = data?.total ?? jobs.length;
  if (count < 1) return null;

  return <>
    <AppButton id={`${id}-trigger`} variant="outlined" aria-haspopup="menu" aria-expanded={Boolean(anchor)} aria-controls={anchor ? id : undefined}
      aria-label={`查看 ${count} 个进行中的调研`} title={`查看 ${count} 个进行中的调研`} onClick={event => setAnchor(event.currentTarget)}
      sx={{ gap: space.sm, color: 'text.secondary', borderColor: 'divider' }}>
      <CircularProgress size={14} aria-hidden />
      <Box component="span" sx={{ display: { xs: 'none', lg: 'inline' } }}>{count} 个调研进行中</Box>
      <Box component="span" sx={{ display: { xs: 'inline', lg: 'none' }, fontVariantNumeric: 'tabular-nums' }}>{count}</Box>
    </AppButton>
    <Menu id={id} anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { className: 'material-surface', sx: { width: '352px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'min(440px, 80dvh)' } }, list: { 'aria-labelledby': `${id}-trigger` } }}>
      <ListSubheader disableSticky sx={{ bgcolor: 'transparent', lineHeight: 'inherit', padding: space.md }}>
        <Typography variant="fieldTitle" component="p">进行中的 AI 调研</Typography>
        <Typography variant="metadata" component="p" color="text.secondary">{count} 个任务正在处理</Typography>
      </ListSubheader>
      <Divider />
      {jobs.map(job => <MenuItem key={job.jobId} component={Link} href={`/ai-research?job=${job.jobId}`} onClick={() => setAnchor(null)} sx={{ display: 'block', whiteSpace: 'normal', padding: space.md }}>
        <Typography variant="body1" component="span" sx={{ display: 'block', overflowWrap: 'anywhere' }}>{job.topic}</Typography>
        <Typography variant="metadata" component="span" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: space.xs }}>
          {job.status === 'queued' ? '排队中' : job.currentStep ? `正在${job.currentStep}` : '调研进行中'}<ArrowUpRight size={12} aria-hidden />
        </Typography>
      </MenuItem>)}
      {count > jobs.length ? <MenuItem component={Link} href="/ai-research" onClick={() => setAnchor(null)} sx={{ color: 'primary.main' }}>查看全部进行中任务</MenuItem> : null}
    </Menu>
  </>;
}

function GlobalSearchCommand() {
  const router = useRouter();
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const trigger = /Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (trigger && event.key.toLowerCase() === 'k') { event.preventDefault(); router.push('/search'); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);
  return <>
    <AppButton variant="outlined" onClick={() => router.push('/search')} aria-label="打开全局搜索（⌘K）" aria-keyshortcuts="Meta+K Control+K"
      sx={{ display: { xs: 'none', sm: 'flex' }, width: { sm: '176px', xl: '208px' }, flexShrink: 0, justifyContent: 'flex-start', color: 'text.secondary', borderColor: 'divider' }}>
      <SearchIcon aria-hidden /><span>搜索研究内容</span><Box component="kbd" sx={{ marginLeft: 'auto', typography: 'metadata' }}>⌘K</Box>
    </AppButton>
    <IconButton onClick={() => router.push('/search')} aria-label="打开搜索" aria-keyshortcuts="Meta+K Control+K" sx={{ display: { sm: 'none' } }}><SearchIcon size={18} aria-hidden /></IconButton>
  </>;
}

/** Pure nav/user data comes from the server; auth remains outside this island. */
export function Topbar({ navItems, user }: { navItems: NavItem[]; user: ShellUser }) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  return <Box component="header" className="material-surface" sx={{
    position: 'sticky', top: 0, zIndex: 'appBar', display: 'flex', alignItems: 'center', flexShrink: 0,
    minHeight: '56px', gap: { xs: space.xs, sm: space.sm, lg: space.md }, paddingInline: { xs: space.sm, sm: space.lg },
    borderBottom: 1, borderColor: 'divider', backgroundColor: 'background.paper',
  }}>
    <IconButton aria-label="打开导航" aria-haspopup="dialog" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)} sx={{ display: { md: 'none' } }}><MenuIcon size={20} aria-hidden /></IconButton>
    <AppDrawer open={mobileOpen} onClose={() => setMobileOpen(false)} anchor="left" width="288px" title="主导航">
      <Box sx={{ padding: space.sm }}><SidebarNav items={navItems} onNavigate={() => setMobileOpen(false)} /></Box>
    </AppDrawer>
    <Box component={Link} href="/" aria-label="AI技术调研平台首页" sx={{
      display: 'flex', alignItems: 'center', gap: space.sm, minWidth: 0, flexShrink: { xs: 1, md: 0 }, color: 'text.primary', textDecoration: 'none',
    }}>
      <BrandMark />
      <Typography variant="fieldTitle" component="span" noWrap sx={{ display: { md: 'none', lg: 'inline' } }}>AI技术调研平台</Typography>
    </Box>
    <Box sx={{ display: { xs: 'none', md: 'block' }, minWidth: 0, flex: 1, overflowX: 'auto', paddingBlock: space.xs }}><SidebarNav items={navItems} horizontal /></Box>
    <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, gap: space.xs, marginLeft: 'auto' }}>
      <GlobalSearchCommand />
      {user ? <AiResearchIndicator /> : null}
      <ThemeToggle />
      <UserMenu user={user} />
    </Box>
  </Box>;
}
