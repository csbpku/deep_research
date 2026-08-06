'use client';

// /radar —— 技术雷达列表（Searchable via PostgreSQL ILIKE + Array Substring）。
//
// 功能：
//  - 搜索：标题 / 解读 / 标签（后端 ILIKE + unnest）；前端按 Form submit 触发
//  - 过滤器：sourceType（GitHub / arXiv / RSS）、status（雷达内容 / 历史精选 / 已屏蔽）
//  - 分页（Pagination domain component）
//  - 列表卡点击跳转详情（详情页有 AskAiDrawer）

import { useQueries, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Layers3, ListOrdered, Search, Workflow } from 'lucide-react';

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
import { useCurrentUser } from '@/lib/auth/client';
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
  commentCount: number;
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
  { value: 'candidate', label: '雷达内容' },
  { value: 'published', label: '历史精选' },
];

const QUALITY_OPTIONS = [
  { value: 'relevant', label: '相关内容' },
  { value: 'all', label: '全部内容（含噪声）' },
];

const DATE_OPTIONS = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
] as const;

type DateRange = (typeof DATE_OPTIONS)[number]['value'];

function dateFromForRange(range: DateRange): string | null {
  if (range === 'all') return null;
  const date = new Date();
  if (range === 'today') {
    date.setHours(0, 0, 0, 0);
  } else {
    date.setDate(date.getDate() - Number.parseInt(range, 10));
  }
  return date.toISOString();
}

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
    id: 'research',
    sourceType: 'research',
    title: '研究论文',
    description: '与当前工程方向相关的 arXiv 研究',
  },
  {
    id: 'shared',
    sourceType: 'shared',
    title: '用户分享',
    description: '经审核后进入雷达的用户推荐内容',
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
  const me = useCurrentUser();
  const [q, setQ] = useState('');
  const [sourceType, setSourceType] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [quality, setQuality] = useState('relevant');
  const [dateRange, setDateRange] = useState<DateRange>('30d');
  const [page, setPage] = useState(1);
  const [view, setView] = useState<'source' | 'ranked'>('ranked');

  const query = useQuery<RadarListResponse>({
    queryKey: ['radar', q, sourceType, status, quality, dateRange, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (sourceType !== ALL) params.set('sourceType', sourceType);
      if (status !== ALL) params.set('status', status);
      params.set('quality', quality);
      const dateFrom = dateFromForRange(dateRange);
      if (dateFrom) params.set('dateFrom', dateFrom);
      params.set('page', String(page));
      params.set('per_page', '20');
      return fetchRadar(params);
    },
    placeholderData: (prev) => prev,
    enabled: view === 'ranked',
  });

  const groupedQueries = useQueries({
    queries: RADAR_GROUPS.map((group) => ({
      queryKey: ['radar-group', group.id, q, status, quality, dateRange],
      queryFn: () => {
        const params = new URLSearchParams({
          sourceType: group.sourceType,
          quality,
          page: '1',
          per_page: '5',
        });
        const dateFrom = dateFromForRange(dateRange);
        if (dateFrom) params.set('dateFrom', dateFrom);
        if (q) params.set('q', q);
        if (status !== ALL) params.set('status', status);
        return fetchRadar(params);
      },
      enabled: view === 'source',
    })),
  });

  const items = query.data?.items ?? [];
  const totalPages = query.data?.totalPages ?? 1;
  const memberActions = (summaryId: string) => me.data ? (
    <Button asChild type="button" variant="outline" size="xs">
      <Link href={`/ai-research?seed=${summaryId}`} aria-label="深入调研">
        <Workflow />
        深入调研
      </Link>
    </Button>
  ) : null;

  return (
    <div className="mx-auto min-w-0 max-w-shell">
      <PageHeader
        title="技术雷达"
        description="默认按团队价值排序；来源只是证据，不决定阅读顺序。"
        actions={(
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center rounded-lg border border-border bg-card p-1 shadow-sm" aria-label="雷达展示方式">
              <Button
                type="button"
                variant={view === 'ranked' ? 'default' : 'ghost'}
                size="sm"
                className={view === 'ranked' ? 'shadow-sm' : 'text-muted-foreground'}
                title="按团队价值和新鲜度统一排序"
                aria-label="统一排序"
                aria-pressed={view === 'ranked'}
                onClick={() => setView('ranked')}
              >
                <ListOrdered className="size-3.5" />
                统一排序
              </Button>
              <Button
                type="button"
                variant={view === 'source' ? 'default' : 'ghost'}
                size="sm"
                className={view === 'source' ? 'shadow-sm' : 'text-muted-foreground'}
                title="按来源分组巡检"
                aria-label="来源分组"
                aria-pressed={view === 'source'}
                onClick={() => setView('source')}
              >
                <Layers3 className="size-3.5" />
                来源分组
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
          aria-label="搜索雷达内容"
          className="w-full sm:w-64"
        />

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>来源</span>
          <Select
            value={sourceType}
              onValueChange={(v) => { setSourceType(v); setPage(1); setView('ranked'); }}
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
          <span>时间</span>
          <Select
            value={dateRange}
            onValueChange={(v) => { setDateRange(v as DateRange); setPage(1); }}
          >
            <SelectTrigger className="w-32" aria-label="时间范围筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_OPTIONS.map((o) => (
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

      {view === 'source' ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {RADAR_GROUPS.map((group, index) => {
            const groupQuery = groupedQueries[index];
            const groupItems = groupQuery.data?.items ?? [];
            const accent = ['bg-primary', 'bg-status-succeeded-fg', 'bg-status-queued-fg', 'bg-status-running-fg'][index] ?? 'bg-primary';
            return (
              <section key={group.id} className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm" aria-labelledby={`radar-group-${group.id}`}>
                <div className="flex min-w-0 items-start justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${accent}`} aria-hidden />
                    <div className="min-w-0">
                      <h2 id={`radar-group-${group.id}`} className="text-sm font-semibold">{group.title}</h2>
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{group.description}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-primary hover:underline"
                    onClick={() => { setSourceType(group.sourceType); setPage(1); setView('ranked'); }}
                  >
                    {groupQuery.data?.total ?? 0} 条 · 查看全部
                  </button>
                </div>
                {groupQuery.isLoading ? (
                  <div className="grid gap-2.5 p-3">
                    {[0, 1].map((i) => <Skeleton key={i} className="h-36 w-full" />)}
                  </div>
                ) : groupQuery.isError ? (
                  <p className="p-5 text-sm text-destructive">加载失败</p>
                ) : groupItems.length === 0 ? (
                  <p className="p-5 text-sm text-muted-foreground">暂无相关内容</p>
                ) : (
                  <div className="grid gap-2.5 p-3">
                    {groupItems.map((it) => (
                      <RadarCandidateCard
                        key={it.id}
                        candidate={it}
                        memberActions={memberActions(it.id)}
                        currentUserId={me.data?.id ?? null}
                        currentUserRole={me.data?.role ?? null}
                        compact
                      />
                    ))}
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
        <div className="overflow-hidden rounded-md border border-border bg-card">
          {items.map((it) => (
            <RadarCandidateCard
              key={it.id}
              candidate={it}
              memberActions={memberActions(it.id)}
              currentUserId={me.data?.id ?? null}
              currentUserRole={me.data?.role ?? null}
              compact
            />
          ))}
        </div>
      )}

      {view === 'ranked' ? (
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
