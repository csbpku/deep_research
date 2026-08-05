'use client';

// /radar —— 技术雷达列表（Searchable via PostgreSQL ILIKE + Array Substring）。
//
// 功能：
//  - 搜索：标题 / 解读 / 标签（后端 ILIKE + unnest）；前端按 Form submit 触发
//  - 过滤器：sourceType（GitHub / arXiv / RSS）、status（候选 / 已发布 / 已忽略）
//  - 分页（Pagination domain component）
//  - 列表卡点击跳转详情（详情页有 AskAiDrawer）

import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { LayoutGrid, List, Search } from 'lucide-react';

import { RadarCandidateCard } from '@/components/radar/RadarCandidateCard';
import { ShareUrlDialog } from '@/components/radar/ShareUrlDialog';
import { FilterBar } from '@/components/domain/FilterBar';
import { PageHeader } from '@/components/domain/PageHeader';
import { Pagination } from '@/components/domain/Pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import type { RadarFeedbackCounts } from '@/components/radar/RadarFeedbackBar';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';
import { SOURCE_TYPE_FILTER_OPTIONS } from '@/lib/radar/source-labels';

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

// 雷达搜索：哨兵值是空串，对应 API 的 "全部"
const ALL = '__all__';

const SOURCE_TYPE_OPTIONS = [
  { value: ALL, label: '全部来源' },
  ...SOURCE_TYPE_FILTER_OPTIONS,
];

const STATUS_OPTIONS = [
  { value: ALL, label: '全部状态' },
  { value: 'candidate', label: '候选' },
  { value: 'published', label: '已发布' },
  { value: 'rejected', label: '已忽略' },
];

const QUALITY_OPTIONS = [
  { value: 'relevant', label: '相关内容' },
  { value: 'all', label: '全部内容（含噪声）' },
];

const RADAR_GROUPS = [
  {
    id: 'github',
    sourceType: 'github',
    title: 'GitHub 更新',
    description: '仓库动态、Release 与工程工具',
  },
  {
    id: 'articles',
    sourceType: 'articles',
    title: '技术文章',
    description: '工程实践、厂商博客与深度解读',
  },
  {
    id: 'community',
    sourceType: 'community',
    title: '社区动态',
    description: 'Hacker News、Product Hunt 与社区讨论',
  },
  {
    id: 'arxiv',
    sourceType: 'arxiv',
    title: '研究论文',
    description: '与当前工程方向相关的 arXiv 研究',
  },
] as const;

async function fetchRadar(params: URLSearchParams): Promise<RadarListResponse> {
  const r = await fetch(`/api/radar?${params.toString()}`, { cache: 'no-store' });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ message: '加载失败' }));
    throw new Error(err.message ?? '加载失败');
  }
  return (await r.json()) as RadarListResponse;
}

export default function RadarPage() {
  const [q, setQ] = useState('');
  const [sourceType, setSourceType] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [quality, setQuality] = useState('relevant');
  const [page, setPage] = useState(1);
  const [view, setView] = useState<'grouped' | 'list'>('grouped');

  const query = useQuery<RadarListResponse>({
    queryKey: ['radar', q, sourceType, status, quality, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (sourceType !== ALL) params.set('sourceType', sourceType);
      if (status !== ALL) params.set('status', status);
      params.set('quality', quality);
      params.set('page', String(page));
      params.set('per_page', '20');
      return fetchRadar(params);
    },
    placeholderData: (prev) => prev,
    enabled: view === 'list',
  });

  const groupedQueries = useQueries({
    queries: RADAR_GROUPS.map((group) => ({
      queryKey: ['radar-group', group.id, q, status, quality],
      queryFn: () => {
        const params = new URLSearchParams({
          sourceType: group.sourceType,
          quality,
          page: '1',
          per_page: '5',
        });
        if (q) params.set('q', q);
        if (status !== ALL) params.set('status', status);
        return fetchRadar(params);
      },
      enabled: view === 'grouped',
    })),
  });

  const items = query.data?.items ?? [];
  const totalPages = query.data?.totalPages ?? 1;

  return (
    <div className="mx-auto min-w-0 max-w-shell">
      <PageHeader
        title="技术雷达"
        description="每个条目附带 AI 一句话解读与多维度评分；点击标题进入详情。"
        actions={(
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-border p-0.5" aria-label="雷达展示方式">
              <Button
                type="button"
                variant={view === 'grouped' ? 'secondary' : 'ghost'}
                size="icon-sm"
                title="分类视图"
                aria-label="分类视图"
                onClick={() => setView('grouped')}
              >
                <LayoutGrid />
              </Button>
              <Button
                type="button"
                variant={view === 'list' ? 'secondary' : 'ghost'}
                size="icon-sm"
                title="列表视图"
                aria-label="列表视图"
                onClick={() => setView('list')}
              >
                <List />
              </Button>
            </div>
            <ShareUrlDialog />
          </div>
        )}
      />

      <FilterBar
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          void query.refetch();
        }}
        trailing={query.isFetching ? '加载中…' : query.data ? `共 ${query.data.total} 条` : undefined}
      >
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索标题 / 解读 / 标签…"
          aria-label="搜索雷达候选"
          className="w-full sm:w-64"
        />

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>来源</span>
          <Select
            value={sourceType}
            onValueChange={(v) => { setSourceType(v); setPage(1); setView('list'); }}
          >
            <SelectTrigger className="w-32" aria-label="来源类型筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_TYPE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>状态</span>
          <Select
            value={status}
            onValueChange={(v) => { setStatus(v); setPage(1); }}
          >
            <SelectTrigger className="w-32" aria-label="状态筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>质量</span>
          <Select
            value={quality}
            onValueChange={(v) => { setQuality(v); setPage(1); }}
          >
            <SelectTrigger className="w-40" aria-label="质量筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {QUALITY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <Button type="submit" size="sm">
          <Search />
          搜索
        </Button>
      </FilterBar>

      {view === 'grouped' ? (
        <div className="grid min-w-0 gap-x-6 gap-y-8 xl:grid-cols-2">
          {RADAR_GROUPS.map((group, index) => {
            const groupQuery = groupedQueries[index];
            const groupItems = groupQuery.data?.items ?? [];
            return (
              <section key={group.id} className="min-w-0" aria-labelledby={`radar-group-${group.id}`}>
                <div className="mb-3 flex min-w-0 items-end justify-between gap-3 border-b border-border pb-2">
                  <div className="min-w-0">
                    <h2 id={`radar-group-${group.id}`} className="text-base font-semibold">{group.title}</h2>
                    <p className="truncate text-xs text-muted-foreground">{group.description}</p>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-primary hover:underline"
                    onClick={() => { setSourceType(group.sourceType); setPage(1); setView('list'); }}
                  >
                    查看全部 {groupQuery.data?.total ?? 0}
                  </button>
                </div>
                {groupQuery.isLoading ? (
                  <div className="grid gap-3">
                    {[0, 1].map((i) => <Skeleton key={i} className="h-36 w-full" />)}
                  </div>
                ) : groupQuery.isError ? (
                  <p className="py-8 text-sm text-destructive">加载失败</p>
                ) : groupItems.length === 0 ? (
                  <p className="py-8 text-sm text-muted-foreground">暂无相关内容</p>
                ) : (
                  <div className="grid gap-3">
                    {groupItems.map((it) => <RadarCandidateCard key={it.id} candidate={it} />)}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : query.isLoading ? (
        <div className="grid min-w-0 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2 rounded-lg border border-border bg-card p-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <EmptyState title="加载失败" description={String((query.error as Error).message)} />
      ) : items.length === 0 ? (
        <EmptyState
          title="暂无候选"
          description="雷达同步尚未产出候选；稍后再来或联系 admin 触发手动同步。"
        />
      ) : (
        <div className="grid gap-3">
          {items.map((it) => (
            <RadarCandidateCard key={it.id} candidate={it} />
          ))}
        </div>
      )}

      {view === 'list' ? (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          disabled={query.isFetching}
        />
      ) : null}
    </div>
  );
}
