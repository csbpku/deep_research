'use client';

// Admin 控制台客户端组件 —— Week 8：仪表板 + 3 个审核队列。
// 由 app/admin/page.tsx（Server Component）做鉴权拦截后渲染。

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  DollarSign,
  ExternalLink,
  Library,
  Lightbulb,
  Link2,
  MessageSquare,
  Settings as SettingsIcon,
  User,
  Radar as RadarIcon,
  ShieldCheck,
  Sparkles,
  Timer,
  X,
} from 'lucide-react';

import { StatCard } from '@/components/domain/StatCard';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/domain/PageHeader';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AdminActionDialog, type AdminActionValues } from '@/components/admin/AdminActionDialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatSourceType } from '@/lib/radar/source-labels';
import type { RadarFeedbackCounts } from '@/components/radar/RadarFeedbackBar';

type Tab = 'dashboard' | 'radar' | 'shares' | 'comments' | 'users' | 'settings';

const TABS: { key: Tab; label: string; icon: typeof RadarIcon }[] = [
  { key: 'dashboard', label: '仪表板', icon: ShieldCheck },
  { key: 'radar', label: '雷达候选', icon: RadarIcon },
  { key: 'shares', label: '用户分享', icon: Link2 },
  { key: 'comments', label: '评论提名', icon: Lightbulb },
  { key: 'users', label: '成员', icon: User },
  { key: 'settings', label: '设置', icon: SettingsIcon },
];

interface DashboardData {
  pendingReviews: { total: number; shares: number; radarCandidates: number; commentNominations: number };
  content: { newResearchesThisWeek: number };
  jobs: { submittedLast24h: number; failedLast24h: number; failedImportJobs: number };
  cost: { monthUsdCents: number; monthUsd: string };
  radar: {
    lastSync: null | {
      id: string;
      source: { name: string; sourceType: string } | null;
      status: string;
      completedAt: string | null;
      createdAt: string;
      errorCode: string | null;
    };
    failedRunsLast24h: number;
  };
  generatedAt: string;
}

interface RadarItem {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  sourceType: string | null;
  tags: string[];
  status: string;
  interpretation: string | null;
  publishedAt: string | null;
  crawledAt: string;
  feedbackCounts: RadarFeedbackCounts;
}

interface RadarListResponse {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  items: RadarItem[];
}

interface ShareItem {
  id: string;
  url: string;
  canonicalUrl: string;
  userNote: string | null;
  fetchedTitle: string | null;
  summaryText: string | null;
  fetchErrorCode: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  completedAt: string | null;
  submitter: { id: string; name: string; email: string };
  reviewer: { id: string; name: string } | null;
}

interface ShareListResponse {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  items: ShareItem[];
}

interface CommentItem {
  id: string;
  body: string;
  starCount: number;
  promoteStatus: 'none' | 'nominated' | 'approved' | 'rejected';
  targetType: 'research' | 'summary';
  summary: { id: string; title: string } | null;
  research: { id: string; title: string } | null;
  createdAt: string;
  author: { id: string; name: string; email: string };
}

interface CommentListResponse {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  items: CommentItem[];
}

export default function AdminConsole() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <div className="mx-auto max-w-shell">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <ShieldCheck className="size-5 text-destructive" />
          Admin 控制台
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理内容质量、监控平台健康度。仅 admin 角色可见。
        </p>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="w-full justify-start overflow-x-auto">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <TabsTrigger key={t.key} value={t.key}>
                <Icon className="size-4" />
                {t.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      <div className="mt-4">
        {tab === 'dashboard' && <DashboardTab />}
        {tab === 'radar' && <RadarTab />}
        {tab === 'shares' && <SharesTab />}
        {tab === 'comments' && <CommentsTab />}
        {tab === 'users' && <UsersTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}

/** 队列筛选胶囊组 —— 三个 tab 页共用。 */
function FilterPills<T extends string>({
  options,
  value,
  onChange,
  trailing,
}: {
  options: ReadonlyArray<{ key: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1">
      {options.map((o) => (
        <Button
          key={o.key}
          type="button"
          variant={value === o.key ? 'default' : 'outline'}
          size="xs"
          className="rounded-full"
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </Button>
      ))}
      {trailing ? (
        <div className="ml-auto text-xs text-muted-foreground">{trailing}</div>
      ) : null}
    </div>
  );
}

function QueueSkeleton() {
  return (
    <div className="grid gap-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 仪表板
// ──────────────────────────────────────────────────────────────────────

function DashboardTab() {
  const q = useQuery<DashboardData>({
    queryKey: ['admin-dashboard'],
    queryFn: async () => {
      const r = await fetch('/api/admin/dashboard', { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
    refetchInterval: 30_000,
  });

  if (q.isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }
  if (q.isError || !q.data) {
    return <p className="text-sm text-destructive">{(q.error as Error)?.message ?? '加载失败'}</p>;
  }

  const d = q.data;

  return (
    <div>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={
            <span className="inline-flex items-center gap-1">
              <Timer className="size-3" />
              待审核
            </span>
          }
          value={d.pendingReviews.total}
          hint={`分享 ${d.pendingReviews.shares} · 候选 ${d.pendingReviews.radarCandidates} · 提名 ${d.pendingReviews.commentNominations}`}
          tone={d.pendingReviews.total > 0 ? 'primary' : 'default'}
        />
        <StatCard
          label={
            <span className="inline-flex items-center gap-1">
              <Library className="size-3" />
              本周新增
            </span>
          }
          value={d.content.newResearchesThisWeek}
          hint="已发布调研库"
        />
        <StatCard
          label={
            <span className="inline-flex items-center gap-1">
              <Sparkles className="size-3" />
              AI 调研
            </span>
          }
          value={`${d.jobs.submittedLast24h} / 24h`}
          hint={`失败 ${d.jobs.failedLast24h} · 导入失败 ${d.jobs.failedImportJobs}`}
        />
        <StatCard
          label={
            <span className="inline-flex items-center gap-1">
              <DollarSign className="size-3" />
              本月成本
            </span>
          }
          value={`$${d.cost.monthUsd}`}
          hint="AI 调研"
        />
      </div>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
          <RadarIcon className="size-4 text-muted-foreground" />
          雷达同步状态
        </h2>
        {d.radar.lastSync ? (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>
              最近同步：
              <strong className="font-medium text-foreground">
                {d.radar.lastSync.source?.name ?? '未知源'}
              </strong>
              （{formatSourceType(d.radar.lastSync.source?.sourceType).short}）
            </p>
            <p className="flex flex-wrap items-center gap-1.5">
              状态：
              <SyncStatusBadge status={d.radar.lastSync.status} />
              <span className="font-mono text-xs">
                {new Date(
                  d.radar.lastSync.completedAt ?? d.radar.lastSync.createdAt,
                ).toLocaleString('zh-CN')}
              </span>
            </p>
            {d.radar.lastSync.errorCode && (
              <p className="text-destructive">错误码：{d.radar.lastSync.errorCode}</p>
            )}
            <p className="text-xs">
              过去 24h 失败同步次数：
              <strong
                className={cn(
                  'font-mono tabular-nums',
                  d.radar.failedRunsLast24h > 0 ? 'text-destructive' : 'text-foreground',
                )}
              >
                {d.radar.failedRunsLast24h}
              </strong>
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">暂无同步记录</p>
        )}
      </section>

      <p className="mt-4 text-xs text-muted-foreground">
        数据生成时间：{new Date(d.generatedAt).toLocaleString('zh-CN')} · 每 30s 自动刷新
      </p>
    </div>
  );
}

function SyncStatusBadge({ status }: { status: string }) {
  const s = syncStatusStyle(status);
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', s.className)}>
      {s.label}
    </span>
  );
}

/**
 * Pure helper：雷达同步状态 → 中文 label + token 化配色 class。
 * 导出供单测使用（项目未装 @testing-library/react，只测纯函数）。
 */
export function syncStatusStyle(status: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    running: { label: '运行中', className: 'bg-status-running-bg text-status-running-fg' },
    completed: { label: '完成', className: 'bg-status-succeeded-bg text-status-succeeded-fg' },
    partial: { label: '部分', className: 'bg-status-partial-bg text-status-partial-fg' },
    failed: { label: '失败', className: 'bg-status-failed-bg text-status-failed-fg' },
  };
  return map[status] ?? { label: status, className: 'bg-muted text-muted-foreground' };
}

// ──────────────────────────────────────────────────────────────────────
// 雷达候选（简化版列表入口；详细操作仍走 /admin/radar）
// ──────────────────────────────────────────────────────────────────────

const RADAR_STATUS_OPTIONS = [
  { key: 'candidate', label: '候选' },
  { key: 'published', label: '已发布' },
  { key: 'rejected', label: '已忽略' },
  { key: 'archived', label: '已归档' },
] as const;

function RadarTab() {
  const [status, setStatus] = useState<string>('candidate');
  const [page, setPage] = useState(1);

  const q = useQuery<RadarListResponse>({
    queryKey: ['admin-radar-tab', status, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('status', status);
      params.set('page', String(page));
      params.set('per_page', '20');
      const r = await fetch(`/api/admin/radar?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
  });

  return (
    <div>
      <FilterPills
        options={RADAR_STATUS_OPTIONS}
        value={status}
        onChange={(s) => {
          setStatus(s);
          setPage(1);
        }}
        trailing={
          <span className="inline-flex items-center gap-2">
            共 {q.data?.total ?? '?'} 条
            <Link
              href="/admin/radar"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              打开完整管理
              <ExternalLink className="size-3" />
            </Link>
          </span>
        }
      />

      {q.isLoading && <QueueSkeleton />}
      {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

      <ul className="grid list-none gap-2 p-0">
        {(q.data?.items ?? []).map((it) => (
          <li key={it.id}>
            <Card className="transition-colors duration-200 hover:border-primary/40">
              <CardContent className="p-3">
                <Link
                  href={`/admin/radar/${it.id}`}
                  className="block text-sm font-medium hover:text-primary hover:underline"
                >
                  {it.title}
                </Link>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatSourceType(it.sourceType).short} · {new Date(it.crawledAt).toLocaleDateString('zh-CN')}
                  {it.interpretation && ` · ${it.interpretation.slice(0, 60)}…`}
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {q.data && q.data.totalPages > 1 && (
        <nav aria-label="分页" className="mt-4 flex items-center justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            上一页
          </Button>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {page} / {q.data.totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= q.data.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </nav>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 用户分享审核
// ──────────────────────────────────────────────────────────────────────

const SHARE_STATUS_OPTIONS = [
  { key: 'pending', label: '待审核' },
  { key: 'approved', label: '已批准' },
  { key: 'rejected', label: '已拒绝' },
] as const;

function SharesTab() {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [page, setPage] = useState(1);
  const [rejectingShare, setRejectingShare] = useState<{ id: string; title: string } | null>(null);
  const queryClient = useQueryClient();

  const q = useQuery<ShareListResponse>({
    queryKey: ['admin-shares', status, page],
    queryFn: async () => {
      const params = new URLSearchParams({ status, page: String(page), per_page: '20' });
      const r = await fetch(`/api/admin/shares?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
  });

  const reviewMut = useMutation({
    mutationFn: async (input: { id: string; action: 'approve' | 'reject'; reason?: string }) => {
      const r = await fetch(`/api/admin/shares/${input.id}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: input.action, reason: input.reason ?? '审核拒绝' }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '操作失败' }));
        throw new Error((err as { message?: string }).message ?? '操作失败');
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-shares'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
  });

  return (
    <div>
      <FilterPills
        options={SHARE_STATUS_OPTIONS}
        value={status}
        onChange={(s) => {
          setStatus(s);
          setPage(1);
        }}
        trailing={`共 ${q.data?.total ?? '?'} 条`}
      />

      {q.isLoading && <QueueSkeleton />}
      {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

      <ul className="grid list-none gap-2.5 p-0">
        {(q.data?.items ?? []).map((it) => (
          <li key={it.id}>
            <Card className="transition-colors duration-200 hover:border-primary/40">
              <CardContent className="p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold">
                  <a
                    href={it.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-primary hover:underline"
                  >
                    {it.fetchedTitle ?? it.url}
                  </a>
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  分享人：{it.submitter.name}（{it.submitter.email}） ·{' '}
                  {new Date(it.createdAt).toLocaleString('zh-CN')}
                </p>
                {it.userNote && (
                  <p className="mt-1.5 flex items-start gap-1.5 rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                    <MessageSquare className="mt-0.5 size-3 shrink-0" />
                    {it.userNote}
                  </p>
                )}
                {it.summaryText && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-primary">查看 AI 摘要</summary>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                      {it.summaryText.slice(0, 500)}
                      {it.summaryText.length > 500 && '…'}
                    </p>
                  </details>
                )}
                {it.fetchErrorCode && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                    <AlertTriangle className="size-3" />
                    抓取失败：{it.fetchErrorCode}
                  </p>
                )}
              </div>
              {status === 'pending' && (
                <div className="flex shrink-0 flex-col gap-1.5">
                  <Button
                    type="button"
                    size="xs"
                    disabled={reviewMut.isPending || !it.summaryText}
                    onClick={() => reviewMut.mutate({ id: it.id, action: 'approve' })}
                  >
                    <Check />
                    批准
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="text-destructive"
                    disabled={reviewMut.isPending}
                    onClick={() => setRejectingShare({ id: it.id, title: it.fetchedTitle ?? it.url })}
                  >
                    <X />
                    拒绝
                  </Button>
                </div>
              )}
            </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {reviewMut.isError && (
        <p className="mt-2 text-xs text-destructive">
          操作失败：{(reviewMut.error as Error).message}
        </p>
      )}

      <AdminActionDialog
        open={!!rejectingShare}
        onOpenChange={(o) => !o && setRejectingShare(null)}
        title="拒绝分享"
        description={rejectingShare ? <>分享：<strong className="font-medium text-foreground">{rejectingShare.title}</strong></> : undefined}
        fields={[
          { kind: 'textarea', id: 'reason', label: '拒绝原因', required: true, rows: 3, placeholder: '例如：与平台主题无关 / 内容质量不足' },
        ]}
        confirmLabel="确认拒绝"
        destructive
        pending={reviewMut.isPending}
        onSubmit={async (values) => {
          if (!rejectingShare) return;
          await reviewMut.mutateAsync({ id: rejectingShare.id, action: 'reject', reason: String(values.reason) });
          setRejectingShare(null);
        }}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 评论提名
// ──────────────────────────────────────────────────────────────────────

const COMMENT_STATUS_OPTIONS = [
  { key: 'pending', label: '待提炼' },
  { key: 'approved', label: '已提炼' },
  { key: 'rejected', label: '已拒绝' },
  { key: 'all', label: '全部' },
] as const;

function CommentsTab() {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [promotingComment, setPromotingComment] = useState<{ id: string; defaultTitle: string; body: string } | null>(null);
  const [dismissingComment, setDismissingComment] = useState<{ id: string; excerpt: string } | null>(null);
  const queryClient = useQueryClient();

  const q = useQuery<CommentListResponse>({
    queryKey: ['admin-comments', status],
    queryFn: async () => {
      const params = new URLSearchParams({ status, page: '1', per_page: '30' });
      const r = await fetch(`/api/admin/comments?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
  });

  const promoteMut = useMutation({
    mutationFn: async (input: { id: string; title: string; body: string; tags: string[]; conclusion?: string }) => {
      const r = await fetch(`/api/admin/comments/${input.id}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: input.title, body: input.body, tags: input.tags, conclusion: input.conclusion }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '提炼失败' }));
        throw new Error((err as { message?: string }).message ?? '提炼失败');
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-comments'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
  });

  const dismissMut = useMutation({
    mutationFn: async (input: { id: string; reason: string }) => {
      const r = await fetch(`/api/admin/comments/${input.id}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: input.reason }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '拒绝失败' }));
        throw new Error((err as { message?: string }).message ?? '拒绝失败');
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-comments'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
  });

  return (
    <div>
      <FilterPills
        options={COMMENT_STATUS_OPTIONS}
        value={status}
        onChange={setStatus}
        trailing={`共 ${q.data?.total ?? '?'} 条`}
      />

      {q.isLoading && <QueueSkeleton />}
      {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

      <ul className="grid list-none gap-2.5 p-0">
        {(q.data?.items ?? []).map((it) => (
          <li key={it.id}>
            <Card className="transition-colors duration-200 hover:border-primary/40">
              <CardContent className="p-3.5">
                <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <strong className="font-medium text-foreground">{it.author.name}</strong>（
              {it.author.email}） · {new Date(it.createdAt).toLocaleString('zh-CN')} ·
              <span className="inline-flex items-center gap-0.5">
                <Sparkles className="size-3" />
                {it.starCount}
              </span>
              {it.targetType === 'summary' && it.summary && (
                <>
                  · 来自摘要:
                  <Link href={`/summaries/${it.summary.id}`} className="text-primary hover:underline">
                    {it.summary.title}
                  </Link>
                </>
              )}
              {it.targetType === 'research' && it.research && (
                <>
                  · 来自调研库:
                  <Link
                    href={`/researches/${it.research.id}`}
                    className="text-primary hover:underline"
                  >
                    {it.research.title}
                  </Link>
                </>
              )}
            </p>

            <blockquote className="my-2 rounded-r border-l-2 border-l-primary bg-muted/50 px-3 py-2 text-sm leading-relaxed">
              {it.body}
            </blockquote>

            {it.promoteStatus === 'nominated' && (
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="xs"
                  disabled={promoteMut.isPending || dismissMut.isPending}
                  onClick={() => setPromotingComment({ id: it.id, defaultTitle: it.body.slice(0, 30), body: it.body })}
                >
                  <Sparkles />
                  提炼为精华
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="text-destructive"
                  disabled={dismissMut.isPending}
                  onClick={() => setDismissingComment({ id: it.id, excerpt: it.body.slice(0, 80) })}
                >
                  <X />
                  拒绝
                </Button>
              </div>
            )}
            {it.promoteStatus === 'approved' && (
              <p className="flex items-center gap-1 text-xs text-status-succeeded-fg">
                <CheckCircle2 className="size-3.5" />
                已提炼为精华
              </p>
            )}
            {it.promoteStatus === 'rejected' && (
              <p className="text-xs text-muted-foreground">已拒绝</p>
            )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      <AdminActionDialog
        open={!!promotingComment}
        onOpenChange={(o) => !o && setPromotingComment(null)}
        title="提炼为精华"
        description="系统会基于评论原文生成精华条目，标题可自定义。"
        fields={[
          { kind: 'text', id: 'title', label: '精华标题', required: true, maxLength: 80, defaultValue: promotingComment?.defaultTitle },
          { kind: 'markdown', id: 'body', label: '精华正文', required: true, defaultValue: promotingComment?.body, maxLength: 50000, rows: 10 },
          { kind: 'tags', id: 'tags', label: '标签', defaultValue: [], maxTagLength: 40, maxTags: 10 },
          { kind: 'textarea', id: 'conclusion', label: '结论（可选）', rows: 3, maxLength: 2000 },
        ]}
        confirmLabel="提炼"
        pending={promoteMut.isPending}
        onSubmit={async (values) => {
          if (!promotingComment) return;
          await promoteMut.mutateAsync({ id: promotingComment.id, title: String(values.title), body: String(values.body), tags: Array.isArray(values.tags) ? values.tags : [], conclusion: String(values.conclusion || '').trim() || undefined });
          setPromotingComment(null);
        }}
      />

      <AdminActionDialog
        open={!!dismissingComment}
        onOpenChange={(o) => !o && setDismissingComment(null)}
        title="拒绝评论提名"
        description={dismissingComment ? <>评论原文：<span className="text-foreground">{dismissingComment.excerpt}{dismissingComment.excerpt.length === 80 ? '…' : ''}</span></> : undefined}
        fields={[
          { kind: 'textarea', id: 'reason', label: '拒绝原因', required: true, rows: 3, placeholder: '例如：与精华主题不符' },
        ]}
        confirmLabel="确认拒绝"
        destructive
        pending={dismissMut.isPending}
        onSubmit={async (values) => {
          if (!dismissingComment) return;
          await dismissMut.mutateAsync({ id: dismissingComment.id, reason: String(values.reason) });
          setDismissingComment(null);
        }}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 成员
// ──────────────────────────────────────────────────────────────────────

interface UserListResponse { items: Array<{ id: string; email: string; name: string; role: 'admin' | 'member'; createdAt: string; disabledAt: string | null }> }

function UsersTab() {
  const q = useQuery<UserListResponse>({
    queryKey: ['admin-users'],
    queryFn: async () => {
      const r = await fetch('/api/admin/users', { cache: 'no-store' });
      if (!r.ok) throw new Error('加载成员失败');
      return r.json();
    },
  });
  if (q.isLoading) return <QueueSkeleton />;
  if (q.isError) return <p className="text-sm text-destructive">{(q.error as Error).message}</p>;
  const items = q.data?.items ?? [];
  if (items.length === 0) return <EmptyState title="还没有成员" description="成员由 SSO / 邀请注册后自动加入。" />;
  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">姓名</th>
              <th className="px-4 py-2.5 font-medium">邮箱</th>
              <th className="px-4 py-2.5 font-medium">角色</th>
              <th className="px-4 py-2.5 font-medium">状态</th>
              <th className="px-4 py-2.5 font-medium">加入时间</th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id} className="border-t border-border transition-colors hover:bg-muted/30">
                <td className="px-4 py-2.5">{u.name || '—'}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{u.email}</td>
                <td className="px-4 py-2.5"><Badge variant={u.role === 'admin' ? 'destructive' : 'secondary'}>{u.role === 'admin' ? '管理员' : '成员'}</Badge></td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{u.disabledAt ? '已禁用' : '正常'}</td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{new Date(u.createdAt).toLocaleDateString('zh-CN')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 设置（占位，Phase 1 暂不开放编辑）
// ──────────────────────────────────────────────────────────────────────

const SETTINGS_FIELDS = [
  { id: 'share_daily_cap', label: '分享每日上限', desc: '每位成员每 24h 可提交分享的最大数量。', default: 5, suffix: '次/日' },
  { id: 'ai_budget', label: 'AI 调研预算', desc: '单个 AI 调研任务的硬性成本上限。', default: 200, suffix: '美分' },
  { id: 'score_threshold', label: '雷达打分阈值', desc: '候选进入精选池所需的最低分。', default: 60, suffix: '分' },
] as const;

function SettingsTab() {
  const [values, setValues] = useState<Record<string, number>>(() => Object.fromEntries(SETTINGS_FIELDS.map((f) => [f.id, f.default])));
  return (
    <div className="grid gap-3">
      <div className="rounded-md border border-amber-300/40 bg-amber-50/60 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
        Phase 1 阶段设置项仅展示，不可保存；待 P2 阶段开放编辑。
      </div>
      {SETTINGS_FIELDS.map((f) => (
        <Card key={f.id}>
          <CardContent className="grid gap-2 p-4 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
            <div>
              <p className="text-sm font-medium">{f.label}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{f.desc}</p>
            </div>
            <div className="flex items-center gap-2">
              <Input type="number" value={values[f.id]} disabled onChange={() => undefined} className="w-24 text-right" />
              <span className="text-xs text-muted-foreground">{f.suffix}</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
