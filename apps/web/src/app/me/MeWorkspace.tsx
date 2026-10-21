'use client';

// /me 客户端：tabs 切换 草稿/收藏/模板/设置。
// 设计：useState 切 tab；草稿/收藏/模板列表有 mutate 操作。
// 设置表单独立子组件。

import { useState, useEffect, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { AtSign, Bell, Bookmark, CheckCheck, Copy, FileText, Library, Plus, Reply, Settings as SettingsIcon, Trash2 } from 'lucide-react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Skeleton from '@mui/material/Skeleton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { space, tokens } from '@deep-research/design-system';

import { AppButton as Button } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';
import { EmptyState } from '@/components/EmptyState';
import { PreferencesForm } from '@/components/me/PreferencesForm';
import { DraftActionsMenu } from '@/components/research/DraftActionsMenu';
import { initialMeWorkspaceTab, isMeWorkspaceTab, type MeWorkspaceTab } from './me-tabs';

interface Initial {
  drafts: Array<{ id: string; title: string; updatedAt: string }>;
  bookmarks: Array<{
    id: string;
    targetType: string;
    targetLabel: string;
    targetId: string;
    title: string;
    href: string | null;
    available: boolean;
    note: string | null;
    createdAt: string;
  }>;
  templates: Array<{
    id: string;
    title: string;
    topic: string;
    background: string | null;
    reportType: string;
    sourcePolicy: string;
    tags: string[];
    useCount: number;
    lastUsedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}

export function MeWorkspace({ userEmail, initial }: { userEmail: string; initial: Initial }) {
  const searchParams = useSearchParams();
  const initialTab = searchParams?.get('tab');
  const [tab, setTab] = useState(() => initialMeWorkspaceTab(initialTab));

  useEffect(() => {
    const next = searchParams?.get('tab');
    if (isMeWorkspaceTab(next)) setTab(next);
  }, [searchParams]);

  return (
    <Box data-me-workspace sx={{ display: 'grid', gap: space.md, minWidth: 0 }}>
      <Tabs
        value={tab}
        selectionFollowsFocus
        onChange={(_, next: string) => { if (isMeWorkspaceTab(next)) setTab(next); }}
        variant="scrollable"
        scrollButtons={false}
        aria-label="我的工作区"
        sx={{
          width: '100%', minWidth: 0, borderBottom: 1, borderColor: 'divider',
          '& .MuiTabs-flexContainer': { width: 'max-content', minWidth: '100%' },
          '& .MuiTab-root': { minWidth: 'auto', minHeight: tokens['control-height-row'], px: space.md, gap: space.sm },
          '& .MuiTabs-scroller': { scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } },
          '@media (pointer: coarse)': {
            '& .MuiTab-root': { minHeight: tokens['touch-target'] },
          },
        }}
      >
        <Tab id="me-tab-drafts" aria-controls="me-panel-drafts" value="drafts" icon={<FileText aria-hidden="true" />} iconPosition="start" label="草稿" />
        <Tab id="me-tab-bookmarks" aria-controls="me-panel-bookmarks" value="bookmarks" icon={<Bookmark aria-hidden="true" />} iconPosition="start" label="收藏" />
        <Tab id="me-tab-templates" aria-controls="me-panel-templates" value="templates" icon={<Library aria-hidden="true" />} iconPosition="start" label="模板" />
        <Tab id="me-tab-notifications" aria-controls="me-panel-notifications" value="notifications" icon={<Bell aria-hidden="true" />} iconPosition="start" label="通知" />
        <Tab id="me-tab-preferences" aria-controls="me-panel-preferences" value="preferences" icon={<SettingsIcon aria-hidden="true" />} iconPosition="start" label="设置" />
      </Tabs>

      <MeTabPanel tab="drafts" active={tab === 'drafts'}>
        {tab === 'drafts' ? <DraftsSection drafts={initial.drafts} /> : null}
      </MeTabPanel>
      <MeTabPanel tab="bookmarks" active={tab === 'bookmarks'}>
        {tab === 'bookmarks' ? <BookmarksSection initial={initial.bookmarks} /> : null}
      </MeTabPanel>
      <MeTabPanel tab="templates" active={tab === 'templates'}>
        {tab === 'templates' ? <TemplatesSection initial={initial.templates} /> : null}
      </MeTabPanel>
      <MeTabPanel tab="notifications" active={tab === 'notifications'}>
        {tab === 'notifications' ? <NotificationsSection /> : null}
      </MeTabPanel>
      <MeTabPanel tab="preferences" active={tab === 'preferences'}>
        {tab === 'preferences' ? <PreferencesForm userEmail={userEmail} /> : null}
      </MeTabPanel>
    </Box>
  );
}

function MeTabPanel({ tab, active, children }: { tab: MeWorkspaceTab; active: boolean; children: ReactNode }) {
  return <Box role="tabpanel" id={`me-panel-${tab}`} aria-labelledby={`me-tab-${tab}`} tabIndex={0} hidden={!active} sx={{ minWidth: 0, outlineOffset: '4px' }}>{children}</Box>;
}

interface NotificationItem {
  id: string;
  type: 'mention' | 'reply';
  readAt: string | null;
  createdAt: string;
  actor: { id: string; name: string; avatarUrl: string | null };
  excerpt: string;
  href: string;
}

function NotificationsSection() {
  const queryClient = useQueryClient();
  const q = useQuery<{ items: NotificationItem[]; unreadCount: number }>({
    queryKey: ['me-notifications'],
    queryFn: async () => {
      const r = await fetch('/api/me/notifications', { cache: 'no-store' });
      if (!r.ok) throw new Error('通知加载失败');
      return r.json();
    },
  });
  const readMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/me/notifications/${id}`, { method: 'PATCH' });
      if (!r.ok) throw new Error('更新通知失败');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me-notifications'] }),
  });
  const readAllMut = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/me/notifications', { method: 'PATCH' });
      if (!r.ok) throw new Error('更新通知失败');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me-notifications'] }),
  });
  const items = q.data?.items ?? [];

  if (q.isLoading) return <Box sx={{ display: 'grid', gap: space.sm, py: space.xl }}><Skeleton variant="text" width="35%" /><Skeleton variant="rounded" height={84} /><Skeleton variant="rounded" height={84} /></Box>;
  if (q.isError) return <Alert severity="error">{(q.error as Error).message}</Alert>;
  if (items.length === 0) return <EmptyState title="暂无通知" description="有人 @你或回复你的评论时，会显示在这里。" />;

  return (
    <Box component="section" aria-label="通知列表" sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: space.sm, mb: space.md }}>
        <Typography component="p" variant="body2" color="text.secondary" sx={{ m: 0 }}>
          {q.data?.unreadCount ? `${q.data.unreadCount} 条未读` : '全部已读'}
        </Typography>
        {Boolean(q.data?.unreadCount) && (
          <Button type="button" size="small" variant="outlined" onClick={() => readAllMut.mutate()} disabled={readAllMut.isPending}>
            <CheckCheck aria-hidden="true" />
            {readAllMut.isPending ? '正在标记…' : '全部标为已读'}
          </Button>
        )}
      </Box>
      {readMut.isError || readAllMut.isError ? <Alert severity="error" sx={{ mb: space.md }}>{((readMut.error ?? readAllMut.error) as Error).message}</Alert> : null}
      <Box component="ul" sx={{ display: 'grid', listStyle: 'none', gap: space.sm, m: 0, p: 0 }}>
        {items.map((item) => {
          const unread = item.readAt === null;
          const Icon = item.type === 'mention' ? AtSign : Reply;
          return (
            <Box component="li" key={item.id}>
              <Box
                component={Link}
                href={item.href}
                onClick={() => unread && readMut.mutate(item.id)}
                aria-label={unread ? `未读:${item.actor.name} ${item.type === 'mention' ? '@了你' : '回复了你'}` : undefined}
                sx={{ display: 'block', color: 'inherit', textDecoration: 'none', borderRadius: tokens['radius-medium'], '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: '2px' } }}
              >
                <Card variant="outlined" sx={{ borderColor: unread ? 'primary.main' : 'divider', bgcolor: unread ? 'action.selected' : 'background.paper', transition: `background-color ${tokens['motion-fast']}, border-color ${tokens['motion-fast']}`, '&:hover': { bgcolor: 'action.hover' } }}>
                  <CardContent sx={{ display: 'flex', alignItems: 'flex-start', gap: space.md, p: space.md, '&:last-child': { pb: space.md } }}>
                    <Box aria-hidden="true" sx={{ mt: '2px', display: 'grid', width: tokens['space-8'], height: tokens['space-8'], flexShrink: 0, placeItems: 'center', borderRadius: tokens['radius-pill'], bgcolor: 'action.selected', color: 'text.secondary' }}>
                      <Icon size={16} />
                    </Box>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.xs }}>
                        <Typography component="span" variant="body2" sx={{ fontWeight: 'fontWeightMedium' }}>
                          {item.actor.name} {item.type === 'mention' ? '@了你' : '回复了你'}
                        </Typography>
                        <Typography component="time" variant="metadata" color="text.secondary" dateTime={item.createdAt}>
                          {new Date(item.createdAt).toLocaleString('zh-CN')}
                        </Typography>
                        {unread ? <Chip size="small" color="primary" variant="outlined" label="未读" /> : null}
                      </Box>
                      <Typography component="p" variant="body2" color="text.secondary" sx={{ mt: space.xs, mb: 0, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', overflowWrap: 'anywhere' }}>
                        {item.excerpt}
                      </Typography>
                    </Box>
                  </CardContent>
                </Card>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

// ── 草稿 ──────────────────────────────────────────────────────────
function DraftsSection({ drafts }: { drafts: Initial['drafts'] }) {
  const queryClient = useQueryClient();
  const recentDrafts = drafts.slice(0, 5);
  if (drafts.length === 0) {
    return (
      <EmptyState
        title="还没有草稿"
        description="在研究库或 AI 调研中创建草稿；最近草稿会显示在这里。"
        action={
          <Button component={Link} href="/researches?tab=draft" size="small" variant="outlined">
            查看全部草稿
          </Button>
        }
      />
    );
  }
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: space.sm, mb: space.md }}>
        <Typography component="p" variant="body2" color="text.secondary" sx={{ m: 0 }}>
          最近 {recentDrafts.length} 份草稿
          {drafts.length > recentDrafts.length ? ` · 另有 ${drafts.length - recentDrafts.length} 份` : ''}
        </Typography>
        <Button component={Link} href="/researches?tab=draft" variant="outlined" size="small">
          查看全部草稿
        </Button>
      </Box>
      <Box component="ul" sx={{ display: 'grid', listStyle: 'none', gap: space.sm, m: 0, p: 0 }}>
      {recentDrafts.map((d) => (
        <Box component="li" key={d.id}>
          <Card variant="outlined">
            <CardContent sx={{ display: 'flex', alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: space.md, p: space.md, '&:last-child': { pb: space.md } }}>
              <Typography
                component={Link}
                href={`/researches/${d.id}`}
                title={d.title || '未命名草稿'}
                variant="listTitle"
                sx={{ minWidth: 0, flex: 1, color: 'text.primary', textDecoration: 'none', overflowWrap: 'anywhere', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', '&:hover': { color: 'primary.main', textDecoration: 'underline' } }}
              >
                {d.title || '（未命名草稿）'}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: space.sm, flexShrink: 0 }}>
                <Typography
                  component="time"
                  variant="metadata"
                  color="text.secondary"
                  dateTime={d.updatedAt}
                  title={new Date(d.updatedAt).toLocaleString('zh-CN')}
                  sx={{ display: { xs: 'none', sm: 'inline' }, textAlign: 'right' }}
                >
                  {new Date(d.updatedAt).toLocaleDateString('zh-CN')}
                </Typography>
                <DraftActionsMenu
                  researchId={d.id}
                  title={d.title || '未命名草稿'}
                  onDeleted={() => queryClient.invalidateQueries({ queryKey: ['me-drafts'] })}
                />
              </Box>
            </CardContent>
          </Card>
        </Box>
      ))}
      </Box>
    </Box>
  );
}

// ── 收藏 ──────────────────────────────────────────────────────────
function BookmarksSection({ initial }: { initial: Initial['bookmarks'] }) {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<Initial['bookmarks'][number] | null>(null);
  const delMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/me/bookmarks?id=${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('删除失败');
      return r.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me-bookmarks'] });
      setDeleteTarget(null);
    },
  });
  const q = useQuery<{ items: Initial['bookmarks'] }>({
    queryKey: ['me-bookmarks'],
    queryFn: async () => {
      const r = await fetch('/api/me/bookmarks', { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
    initialData: { items: initial },
  });
  const items = q.data?.items ?? [];
  if (items.length === 0) {
    return <EmptyState title="还没有收藏" description="在雷达候选、调研、摘要页面点击收藏按钮即可加入。" />;
  }
  return (
    <Box sx={{ minWidth: 0 }}>
    {delMut.isError ? <Alert severity="error" sx={{ mb: space.md }}>{(delMut.error as Error).message}</Alert> : null}
    <Box component="ul" sx={{ display: 'grid', listStyle: 'none', gap: space.sm, m: 0, p: 0 }}>
      {items.map((b) => (
        <Box component="li" key={b.id}>
          <Card variant="outlined">
            <CardContent sx={{ display: 'flex', alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: space.md, p: space.md, '&:last-child': { pb: space.md } }}>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: space.xs }}>
                  <Chip size="small" variant="outlined" label={b.targetLabel} />
                  <Typography component="time" variant="metadata" color="text.secondary" dateTime={b.createdAt}>
                    {new Date(b.createdAt).toLocaleDateString('zh-CN')}
                  </Typography>
                </Box>
                {b.href ? (
                  <Typography component={Link} href={b.href} variant="listTitle" sx={{ display: 'block', mt: space.xs, color: 'text.primary', textDecoration: 'none', overflowWrap: 'anywhere', '&:hover': { color: 'primary.main', textDecoration: 'underline' } }}>
                    {b.title}
                  </Typography>
                ) : (
                  <Typography component="p" variant="body2" color="text.secondary" sx={{ mt: space.xs, mb: 0, overflowWrap: 'anywhere' }}>{b.title}</Typography>
                )}
                {b.note ? <Typography component="p" variant="body2" sx={{ mt: space.xs, mb: 0, overflowWrap: 'anywhere' }}>{b.note}</Typography> : null}
              </Box>
              <Button
                type="button"
                size="small"
                variant="text"
                color="error"
                disabled={delMut.isPending}
                onClick={() => { delMut.reset(); setDeleteTarget(b); }}
                aria-label={`移除收藏:${b.title ?? b.targetType}`}
              >
                <Trash2 aria-hidden="true" />
                移除
              </Button>
            </CardContent>
          </Card>
        </Box>
      ))}
    </Box>
    {deleteTarget ? (
      <AppDialog
        open
        title="移除收藏"
        description="移除后可以在原页面重新添加。"
        onClose={() => { if (!delMut.isPending) setDeleteTarget(null); }}
        actions={(
          <>
            <Button variant="outlined" onClick={() => setDeleteTarget(null)} disabled={delMut.isPending}>取消</Button>
            <Button color="error" onClick={() => delMut.mutate(deleteTarget.id)} disabled={delMut.isPending}>
              {delMut.isPending ? '正在移除…' : '确认移除'}
            </Button>
          </>
        )}
      >
        <Typography component="p" variant="body1" sx={{ overflowWrap: 'anywhere' }}>{deleteTarget.title}</Typography>
        {delMut.isError ? <Alert severity="error">{(delMut.error as Error).message}</Alert> : null}
      </AppDialog>
    ) : null}
    </Box>
  );
}

// ── 模板 ──────────────────────────────────────────────────────────
function TemplatesSection({ initial }: { initial: Initial['templates'] }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const applyMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/me/templates/${id}/apply`, { method: 'POST' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? '应用失败');
      }
      return r.json() as Promise<{ ok: true; draft: { id: string; title: string } }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['me-templates'] });
      router.push(`/researches/${data.draft.id}/edit`);
    },
  });

  const q = useQuery<{ items: Initial['templates'] }>({
    queryKey: ['me-templates'],
    queryFn: async () => {
      const r = await fetch('/api/me/templates', { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
    initialData: { items: initial },
  });
  const items = q.data?.items ?? [];

  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: space.sm, mb: space.md }}>
        <Typography component="p" variant="body2" color="text.secondary" sx={{ m: 0 }}>
          {items.length} 个模板；点击「使用」可复制出 Research 草稿。
        </Typography>
        <Button type="button" size="small" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          新建模板
        </Button>
      </Box>
      {q.isError ? <Alert severity="error" sx={{ mb: space.md }}>{(q.error as Error).message}</Alert> : null}
      {applyMut.isError ? <Alert severity="error" sx={{ mb: space.md }}>{(applyMut.error as Error).message}</Alert> : null}
      {!q.isError && items.length === 0 ? (
        <EmptyState title="还没有模板" description="保存常用调研主题作为模板，下次一键套用。" />
      ) : items.length > 0 ? (
        <Box component="ul" sx={{ display: 'grid', listStyle: 'none', gap: space.sm, m: 0, p: 0 }}>
          {items.map((t) => (
            <Box component="li" key={t.id}>
              <Card variant="outlined">
                <CardContent sx={{ display: 'flex', alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: space.md, p: space.md, '&:last-child': { pb: space.md } }}>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography component="h2" variant="listTitle" sx={{ overflowWrap: 'anywhere' }}>{t.title}</Typography>
                    <Typography component="p" variant="metadata" color="text.secondary" sx={{ mt: space.xs, mb: 0, overflowWrap: 'anywhere' }}>
                      主题：{t.topic} · {t.reportType} · 使用 {t.useCount} 次
                    </Typography>
                    {t.tags.length > 0 ? (
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: space.xs, mt: space.xs }}>
                        {t.tags.map((tag) => (
                          <Chip key={tag} size="small" variant="outlined" label={tag} />
                        ))}
                      </Box>
                    ) : null}
                  </Box>
                  <Button type="button" size="small" onClick={() => applyMut.mutate(t.id)} disabled={applyMut.isPending}>
                    <Copy aria-hidden="true" />
                    {applyMut.isPending && applyMut.variables === t.id ? '正在创建…' : '使用'}
                  </Button>
                </CardContent>
              </Card>
            </Box>
          ))}
        </Box>
      ) : null}
      {creating ? <CreateTemplateDialog onClose={() => setCreating(false)} /> : null}
    </Box>
  );
}

function CreateTemplateDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [background, setBackground] = useState('');
  const createMut = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/me/templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, topic, background: background || undefined, tags: [] }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? '创建失败');
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me-templates'] });
      onClose();
    },
  });
  const closeIfIdle = () => { if (!createMut.isPending) onClose(); };
  return (
    <AppDialog
      open
      onClose={closeIfIdle}
      title="新建调研模板"
      description="保存常用调研主题，之后可一键创建草稿。"
      actions={(
        <>
          <Button type="button" variant="outlined" onClick={closeIfIdle} disabled={createMut.isPending}>取消</Button>
          <Button type="button" onClick={() => createMut.mutate()} disabled={!title.trim() || topic.trim().length < 2 || createMut.isPending}>
            {createMut.isPending ? '正在创建…' : '创建'}
          </Button>
        </>
      )}
    >
      <Box sx={{ display: 'grid', gap: space.md, pt: space.xs }}>
        <TextField
          label="模板名称"
          required
          fullWidth
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          slotProps={{ htmlInput: { maxLength: 200 } }}
        />
        <TextField
          label="调研主题"
          required
          fullWidth
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          helperText="至少填写 2 个字符"
          slotProps={{ htmlInput: { maxLength: 200 } }}
        />
        <TextField
          label="背景（可选）"
          fullWidth
          multiline
          minRows={3}
          value={background}
          onChange={(e) => setBackground(e.target.value)}
          slotProps={{ htmlInput: { maxLength: 2000 } }}
        />
        {createMut.error ? <Alert severity="error">{(createMut.error as Error).message}</Alert> : null}
      </Box>
    </AppDialog>
  );
}
