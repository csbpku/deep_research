'use client';

// /admin/radar —— 雷达内容治理。
// 所有操作会写入 admin_actions 审计。

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, MoreHorizontal, RotateCcw, Workflow, X } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { RadarCandidateCard } from '@/components/radar/RadarCandidateCard';
import { AddRadarCandidateDialog } from '@/components/radar/AddRadarCandidateDialog';
import type { RadarFeedbackCounts } from '@/components/radar/RadarFeedbackBar';
import { FilterBar } from '@/components/domain/FilterBar';
import { PageHeader } from '@/components/domain/PageHeader';
import { Pagination } from '@/components/domain/Pagination';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AdminActionDialog } from '@/components/admin/AdminActionDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import { SOURCE_TYPE_FILTER_OPTIONS } from '@/lib/radar/source-labels';
import type { DistilledScore } from '@deep-research/shared/schemas';

interface RadarCandidateListItem {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  sourceType: string | null;
  tags: string[];
  status: string;
  publishedAt: string | null;
  crawledAt: string;
  interpretation: string | null;
  scoreReason: string | null;
  relevanceScore: number | null;
  timelinessScore: number | null;
  sourceQualityScore: number | null;
  distilledScore: DistilledScore | null;
  selectionReason: string | null;
  sortOrder: number | null;
  feedbackCounts: RadarFeedbackCounts;
  myFeedbacks: RadarFeedbackType[];
  commentCount: number;
  topics: Array<{ id: string; slug: string; name: string; tier: string }>;
  issues: Array<{
    id: string;
    title: string;
    kind: 'event' | 'problem';
    importanceScore: number;
    topic: { id: string; slug: string; name: string };
  }>;
}

interface RadarListResponse {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  items: RadarCandidateListItem[];
}

const STATUS_OPTIONS = [
  { value: 'candidate', label: '雷达内容' },
  { value: 'published', label: '历史精选' },
  { value: 'rejected', label: '已屏蔽' },
  { value: 'archived', label: '已归档' },
];

// Radix Select 不接受空串 value，用哨兵表示「全部」。
const ALL_SOURCES = '__all__';
const ALL_QUEUES = 'all';
const QUEUE_OPTIONS = [
  { value: ALL_QUEUES, label: '全部内容' },
  { value: 'pending_score', label: '待评分优先' },
  { value: 'low_confidence', label: '低置信度优先' },
] as const;
type Queue = (typeof QUEUE_OPTIONS)[number]['value'];

export default function AdminRadarClient() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState('candidate');
  const [sourceType, setSourceType] = useState(ALL_SOURCES);
  const [queue, setQueue] = useState<Queue>(ALL_QUEUES);
  const [page, setPage] = useState(1);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<{ id: string; title: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const query = useQuery<RadarListResponse>({
    queryKey: ['adminRadar', status, sourceType, queue, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('status', status);
      params.set('adminQueue', queue);
      if (sourceType !== ALL_SOURCES) params.set('sourceType', sourceType);
      params.set('page', String(page));
      params.set('per_page', '20');
      const r = await fetch(`/api/admin/radar?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ code: '', message: '加载失败' }));
        if (err?.code === 'AUTH_NOT_AUTHENTICATED') {
          if (typeof window !== 'undefined') {
            window.location.href = `/signin?callbackUrl=${encodeURIComponent(window.location.pathname)}`;
          }
          throw new Error('需要登录，正在跳转…');
        }
        throw new Error(err.message ?? '加载失败');
      }
      return (await r.json()) as RadarListResponse;
    },
    placeholderData: (prev) => prev,
  });

  const dismissMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/radar/${id}/dismiss`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? '屏蔽失败');
      }
      return r.json();
    },
    onSuccess: () => {
      setActionErr(null);
      void queryClient.invalidateQueries({ queryKey: ['adminRadar'] });
    },
    onError: (e) => {
      setActionErr(e instanceof Error ? e.message : '屏蔽失败');
    },
  });

  const createResearchMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/radar/${id}/create-research`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? '创建调研失败');
      }
      return r.json();
    },
    onSuccess: (data) => {
      setActionErr(null);
      const researchId = (data as { research?: { id?: string } }).research?.id;
      if (researchId) router.push(`/researches/${researchId}/edit`);
    },
    onError: (e) => {
      setActionErr(e instanceof Error ? e.message : '创建调研失败');
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/radar/${id}/restore`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? '恢复失败');
      }
      return r.json();
    },
    onSuccess: () => {
      setActionErr(null);
      void queryClient.invalidateQueries({ queryKey: ['adminRadar'] });
    },
    onError: (e) => {
      setActionErr(e instanceof Error ? e.message : '恢复失败');
    },
  });

  const items = query.data?.items ?? [];
  const totalPages = query.data?.totalPages ?? 1;
  const actionableItems = items.filter((item) => item.status === 'candidate' || item.status === 'rejected');
  const allVisibleSelected = actionableItems.length > 0
    && actionableItems.every((item) => selectedIds.includes(item.id));
  const selectedStatus = useMemo(() => {
    const selected = items.filter((item) => selectedIds.includes(item.id));
    if (selected.length === 0) return null;
    return selected.every((item) => item.status === 'rejected') ? 'rejected' : 'candidate';
  }, [items, selectedIds]);

  const bulkActionMutation = useMutation({
    mutationFn: async (action: 'dismiss' | 'restore') => {
      const responses = await Promise.all(
        selectedIds.map((id) => fetch(`/api/admin/radar/${id}/${action}`, { method: 'POST' })),
      );
      const failed = responses.find((response) => !response.ok);
      if (failed) {
        const body = await failed.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? '批量操作失败');
      }
      return selectedIds.length;
    },
    onSuccess: (count, action) => {
      setSelectedIds([]);
      setActionErr(`${count} 条内容已${action === 'dismiss' ? '屏蔽' : '恢复'}`);
      void queryClient.invalidateQueries({ queryKey: ['adminRadar'] });
    },
    onError: (error) => setActionErr(error instanceof Error ? error.message : '批量操作失败'),
  });

  useEffect(() => {
    setSelectedIds([]);
  }, [page, queue, sourceType, status]);

  function toggleSelected(id: string, checked: boolean) {
    setSelectedIds((current) => checked
      ? (current.includes(id) ? current : [...current, id])
      : current.filter((itemId) => itemId !== id));
  }

  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title="Admin · 雷达治理"
        description="按需巡检和屏蔽无关内容，或从高价值信号创建调研；雷达内容无需逐条审批。"
        actions={<AddRadarCandidateDialog />}
      />

      <FilterBar
        trailing={query.isFetching ? '加载中…' : query.data ? `共 ${query.data.total} 条` : null}
      >
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-32" aria-label="状态">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={sourceType}
          onValueChange={(v) => {
            setSourceType(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-32" aria-label="来源">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SOURCES}>全部来源</SelectItem>
            {SOURCE_TYPE_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={queue}
          onValueChange={(v) => {
            setQueue(v as Queue);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-36" aria-label="优先队列">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {QUEUE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterBar>

      {query.data ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {QUEUE_OPTIONS.find((option) => option.value === queue)?.label}
          </span>
          <span>当前页 {items.length} 条 / 共 {query.data.total} 条</span>
          <span>按评分或风险信号优先排序</span>
        </div>
      ) : null}

      {actionErr ? (
        <div
          role="alert"
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive"
        >
          {actionErr}
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="grid gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : query.isError ? (
        <EmptyState title="加载失败" description={String((query.error as Error).message)} />
      ) : items.length === 0 ? (
        <EmptyState title="暂无内容" description={`当前状态 ${status} 下没有雷达条目。`} />
      ) : (
        <div className="space-y-2">
          {actionableItems.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
              <label className="inline-flex cursor-pointer items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={(event) => setSelectedIds(event.target.checked ? actionableItems.map((item) => item.id) : [])}
                  aria-label="全选当前页可治理内容"
                  className="size-3.5 accent-primary"
                />
                全选当前页
              </label>
              {selectedIds.length > 0 ? (
                <>
                  <span className="text-muted-foreground">已选 {selectedIds.length} 条</span>
                  {selectedStatus === 'candidate' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={bulkActionMutation.isPending}
                      onClick={() => {
                        if (window.confirm(`确定屏蔽选中的 ${selectedIds.length} 条内容吗？`)) {
                          bulkActionMutation.mutate('dismiss');
                        }
                      }}
                    >
                      <X />
                      批量屏蔽
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="xs"
                      disabled={bulkActionMutation.isPending}
                      onClick={() => bulkActionMutation.mutate('restore')}
                    >
                      <Check />
                      批量恢复
                    </Button>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">批量屏蔽或恢复当前页内容</span>
              )}
            </div>
          ) : null}
          <div className="grid gap-3">
          {items.map((it) => (
            <div key={it.id} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
              {it.status === 'candidate' || it.status === 'rejected' ? (
                <input
                  type="checkbox"
                  checked={selectedIds.includes(it.id)}
                  onChange={(event) => toggleSelected(it.id, event.target.checked)}
                  aria-label={`选择雷达条目：${it.title}`}
                  className="mt-5 size-3.5 shrink-0 accent-primary"
                />
              ) : (
                <span aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <RadarCandidateCard
                candidate={it}
                adminActions={
                  <RadarAdminActions
                    status={it.status}
                    onCreateResearch={() => createResearchMutation.mutate(it.id)}
                    onDismiss={() => setDismissing({ id: it.id, title: it.title })}
                    onRestore={() => restoreMutation.mutate(it.id)}
                    disabled={
                      createResearchMutation.isPending
                      || dismissMutation.isPending
                      || restoreMutation.isPending
                      || bulkActionMutation.isPending
                    }
                  />
                }
              />
            </div>
          ))}
          </div>
        </div>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        disabled={query.isFetching}
      />

      <AdminActionDialog
        open={!!dismissing}
        onOpenChange={(o) => !o && setDismissing(null)}
        title="屏蔽该雷达条目？"
        description={dismissing ? <>条目：<strong className="font-medium text-foreground">{dismissing.title}</strong>。屏蔽后不会再出现在默认雷达，仍可在「已屏蔽」状态下恢复或审计。</> : undefined}
        fields={[
          { kind: 'static', id: 'note', label: '说明', value: '该操作会写入 admin_actions 审计日志，已有评论和引用不会被物理删除。' },
        ]}
        confirmLabel="确认屏蔽"
        cancelLabel="保留内容"
        destructive
        pending={dismissMutation.isPending}
        onSubmit={async () => {
          if (!dismissing) return;
          await dismissMutation.mutateAsync(dismissing.id);
          setDismissing(null);
        }}
      />
    </div>
  );
}

function RadarAdminActions({
  status,
  onCreateResearch,
  onDismiss,
  onRestore,
  disabled,
}: {
  status: string;
  onCreateResearch: () => void;
  onDismiss: () => void;
  onRestore: () => void;
  disabled: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          aria-label="打开雷达治理操作"
          title="更多操作"
          disabled={disabled}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onCreateResearch}>
          <Workflow />
          创建 AI 调研
        </DropdownMenuItem>
        {status === 'candidate' ? (
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDismiss}>
            <X />
            屏蔽
          </DropdownMenuItem>
        ) : null}
        {status === 'rejected' ? (
          <DropdownMenuItem onSelect={onRestore}>
            <RotateCcw />
            恢复到雷达
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
