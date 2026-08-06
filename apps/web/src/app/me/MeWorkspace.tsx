'use client';

// /me 客户端：tabs 切换 草稿/收藏/模板/设置。
// 设计：useState 切 tab；草稿/收藏/模板列表有 mutate 操作。
// 设置表单独立子组件。

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { AtSign, Bell, Bookmark, CheckCheck, Copy, FileText, Library, Plus, Reply, Settings as SettingsIcon, Trash2 } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { PreferencesForm } from '@/components/me/PreferencesForm';
import { DeleteDraftButton } from '@/components/research/DeleteDraftButton';

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
  const validTabs = ['drafts', 'bookmarks', 'templates', 'notifications', 'preferences'];
  const [tab, setTab] = useState(
    initialTab && validTabs.includes(initialTab) ? initialTab : 'drafts',
  );

  useEffect(() => {
    const next = searchParams?.get('tab');
    if (next && validTabs.includes(next)) setTab(next);
  }, [searchParams]);

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="h-auto flex-wrap justify-start">
        <TabsTrigger value="drafts">
          <FileText className="size-3" />
          草稿
        </TabsTrigger>
        <TabsTrigger value="bookmarks">
          <Bookmark className="size-3" />
          收藏
        </TabsTrigger>
        <TabsTrigger value="templates">
          <Library className="size-3" />
          模板
        </TabsTrigger>
        <TabsTrigger value="notifications">
          <Bell className="size-3" />
          通知
        </TabsTrigger>
        <TabsTrigger value="preferences">
          <SettingsIcon className="size-3" />
          设置
        </TabsTrigger>
      </TabsList>

      <TabsContent value="drafts">
        <DraftsSection drafts={initial.drafts} />
      </TabsContent>
      <TabsContent value="bookmarks">
        <BookmarksSection initial={initial.bookmarks} />
      </TabsContent>
      <TabsContent value="templates">
        <TemplatesSection initial={initial.templates} />
      </TabsContent>
      <TabsContent value="notifications">
        <NotificationsSection />
      </TabsContent>
      <TabsContent value="preferences">
        <PreferencesForm userEmail={userEmail} />
      </TabsContent>
    </Tabs>
  );
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

  if (q.isLoading) return <p className="py-8 text-sm text-muted-foreground">正在加载通知…</p>;
  if (q.isError) return <p className="py-8 text-sm text-destructive">{(q.error as Error).message}</p>;
  if (items.length === 0) return <EmptyState title="暂无通知" description="有人 @你或回复你的评论时，会显示在这里。" />;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {q.data?.unreadCount ? `${q.data.unreadCount} 条未读` : '全部已读'}
        </p>
        {Boolean(q.data?.unreadCount) && (
          <Button type="button" size="xs" variant="outline" onClick={() => readAllMut.mutate()} disabled={readAllMut.isPending}>
            <CheckCheck className="size-3.5" />
            全部标为已读
          </Button>
        )}
      </div>
      <ul className="grid list-none gap-2 p-0">
        {items.map((item) => {
          const unread = item.readAt === null;
          const Icon = item.type === 'mention' ? AtSign : Reply;
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                onClick={() => unread && readMut.mutate(item.id)}
                className="group block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Card className={unread ? 'border-primary/35 bg-primary/[0.035]' : ''}>
                  <CardContent className="flex gap-3 p-3">
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground group-hover:text-foreground">
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-medium">
                          {item.actor.name} {item.type === 'mention' ? '@了你' : '回复了你'}
                        </span>
                        <span className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
                        {unread && <span className="size-1.5 rounded-full bg-primary" aria-label="未读" />}
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.excerpt}</p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── 草稿 ──────────────────────────────────────────────────────────
function DraftsSection({ drafts }: { drafts: Initial['drafts'] }) {
  if (drafts.length === 0) {
    return (
      <EmptyState
        title="还没有草稿"
        description="在调研库点击「新建草稿」开始写作；这里会显示你最近的 20 条草稿。"
        action={
          <Button asChild size="sm">
            <Link href="/researches?tab=draft">打开草稿列表</Link>
          </Button>
        }
      />
    );
  }
  return (
    <ul className="grid list-none gap-2 p-0">
      {drafts.map((d) => (
        <li key={d.id}>
          <Card>
            <CardContent className="flex items-center justify-between p-3">
              <Link href={`/researches/${d.id}`} className="text-sm font-medium hover:text-primary hover:underline">
                {d.title || '（未命名草稿）'}
              </Link>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {new Date(d.updatedAt).toLocaleString('zh-CN')}
                </span>
                <DeleteDraftButton
                  researchId={d.id}
                  title={d.title || '未命名草稿'}
                  compact
                  onDeleted={() => window.location.reload()}
                />
              </div>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

// ── 收藏 ──────────────────────────────────────────────────────────
function BookmarksSection({ initial }: { initial: Initial['bookmarks'] }) {
  const queryClient = useQueryClient();
  const delMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/me/bookmarks?id=${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('删除失败');
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me-bookmarks'] }),
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
    <ul className="grid list-none gap-2 p-0">
      {items.map((b) => (
        <li key={b.id}>
          <Card>
            <CardContent className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant="secondary">{b.targetLabel}</Badge>
                  <span>{new Date(b.createdAt).toLocaleDateString('zh-CN')}</span>
                </div>
                {b.href ? (
                  <Link href={b.href} className="mt-1 block truncate text-sm font-medium hover:text-primary hover:underline">
                    {b.title}
                  </Link>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">{b.title}</p>
                )}
                {b.note ? <p className="mt-1 text-sm">{b.note}</p> : null}
              </div>
              <Button type="button" size="xs" variant="outline" onClick={() => delMut.mutate(b.id)}>
                <Trash2 className="size-3" />
                移除
              </Button>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
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
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{items.length} 个模板；点击「使用」可复制出 Research 草稿。</p>
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          新建模板
        </Button>
      </div>
      {items.length === 0 ? (
        <EmptyState title="还没有模板" description="保存常用调研主题作为模板，下次一键套用。" />
      ) : (
        <ul className="grid list-none gap-2 p-0">
          {items.map((t) => (
            <li key={t.id}>
              <Card>
                <CardContent className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      主题：{t.topic} · {t.reportType} · 使用 {t.useCount} 次
                    </p>
                    {t.tags.length > 0 ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t.tags.map((tag) => (
                          <Badge key={tag} variant="outline" className="mr-1">
                            {tag}
                          </Badge>
                        ))}
                      </p>
                    ) : null}
                  </div>
                  <Button type="button" size="xs" onClick={() => applyMut.mutate(t.id)} disabled={applyMut.isPending}>
                    <Copy className="size-3" />
                    {applyMut.isPending && applyMut.variables === t.id ? '正在创建…' : '使用'}
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {creating ? <CreateTemplateDialog onClose={() => setCreating(false)} /> : null}
    </div>
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-sm font-semibold">新建调研模板</h3>
        <div className="grid gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="模板名称（必填）" />
          <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="调研主题（必填）" />
          <textarea
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            placeholder="背景（可选）"
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        {createMut.error ? (
          <p className="mt-2 text-xs text-destructive">{(createMut.error as Error).message}</p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="button" size="sm" disabled={!title || !topic || createMut.isPending} onClick={() => createMut.mutate()}>
            创建
          </Button>
        </div>
      </div>
    </div>
  );
}
