'use client';

// /admin/radar —— 雷达候选队列管理。
// 所有操作会写入 admin_actions 审计。

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Workflow, X } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { RadarCandidateCard } from '@/components/radar/RadarCandidateCard';
import type { RadarFeedbackCounts } from '@/components/radar/RadarFeedbackBar';
import { FilterBar } from '@/components/domain/FilterBar';
import { PageHeader } from '@/components/domain/PageHeader';
import { Pagination } from '@/components/domain/Pagination';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { RadarFeedbackType } from '@deep-research/shared/states';
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
}

interface RadarListResponse {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  items: RadarCandidateListItem[];
}

const STATUS_OPTIONS = [
  { value: 'candidate', label: '候选' },
  { value: 'published', label: '已发布' },
  { value: 'rejected', label: '已忽略' },
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
        throw new Error((body as { message?: string }).message ?? '忽略失败');
      }
      return r.json();
    },
    onSuccess: () => {
      setActionErr(null);
      void queryClient.invalidateQueries({ queryKey: ['adminRadar'] });
    },
    onError: (e) => {
      setActionErr(e instanceof Error ? e.message : '忽略失败');
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/radar/${id}/retry-interpretation`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? '重试失败');
      }
      return r.json();
    },
    onSuccess: () => {
      setActionErr(null);
      void queryClient.invalidateQueries({ queryKey: ['adminRadar'] });
    },
    onError: (e) => {
      setActionErr(e instanceof Error ? e.message : '重试失败');
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

  const items = query.data?.items ?? [];
  const totalPages = query.data?.totalPages ?? 1;

  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title="Admin · 雷达队列"
        description="候选状态切换：创建 AI 调研 / 忽略 / 重试解读。所有操作会写入 admin_actions 审计。"
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
            <SelectItem value="github">GitHub</SelectItem>
            <SelectItem value="arxiv">arXiv</SelectItem>
            <SelectItem value="rss">RSS</SelectItem>
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
        <EmptyState title="队列为空" description={`当前状态 ${status} 下没有候选。`} />
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
                      onClick={() => dismissMutation.mutate(it.id)}
                      disabled={dismissMutation.isPending}
                    >
                      <X />
                      忽略
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => retryMutation.mutate(it.id)}
                    disabled={retryMutation.isPending}
                  >
                    <RefreshCw />
                    重试解读
                  </Button>
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
    </div>
  );
}
