'use client';

// /admin/radar —— 雷达内容治理。
// 所有操作会写入 admin_actions 审计。

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCcw, Workflow, X } from 'lucide-react';

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

export default function AdminRadarClient() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState('candidate');
  const [sourceType, setSourceType] = useState(ALL_SOURCES);
  const [page, setPage] = useState(1);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<{ id: string; title: string } | null>(null);

  const query = useQuery<RadarListResponse>({
    queryKey: ['adminRadar', status, sourceType, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('status', status);
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
      </FilterBar>

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
        <div className="grid gap-3">
          {items.map((it) => (
            <RadarCandidateCard
              key={it.id}
              candidate={it}
              adminActions={
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => createResearchMutation.mutate(it.id)}
                    disabled={createResearchMutation.isPending}
                  >
                    <Workflow />
                    创建 AI 调研
                  </Button>
                  {it.status === 'candidate' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="text-destructive"
                      onClick={() => setDismissing({ id: it.id, title: it.title })}
                      disabled={dismissMutation.isPending}
                    >
                      <X />
                      屏蔽
                    </Button>
                  ) : null}
                  {it.status === 'rejected' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => restoreMutation.mutate(it.id)}
                      disabled={restoreMutation.isPending}
                    >
                      <RotateCcw />
                      恢复到雷达
                    </Button>
                  ) : null}
                </div>
              }
            />
          ))}
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
        description={dismissing ? <>条目：<strong className="font-medium text-foreground">{dismissing.title}</strong>。屏蔽后不会再出现在默认雷达和后续日报中，仍可在「已屏蔽」状态下恢复或审计。</> : undefined}
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
