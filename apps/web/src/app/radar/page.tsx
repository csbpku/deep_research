'use client';

// /radar —— 技术雷达列表（Searchable via PostgreSQL ILIKE + Array Substring）。
//
// 功能：
//  - 搜索：标题 / 解读 / 标签（后端 ILIKE + unnest）；前端按 Form submit 触发
//  - 过滤器：sourceType（GitHub / arXiv / RSS）、quality（核心材料 / 推荐精读）
//  - 分页（Pagination domain component）
//  - 列表卡点击跳转详情（详情页有 AskAiDrawer）

import { useQueries, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  ChevronDown,
  Layers3,
  ListOrdered,
  RotateCcw,
  Search,
  SlidersHorizontal,
} from 'lucide-react';

import { RadarCandidateCard } from '@/components/radar/RadarCandidateCard';
import { ShareUrlDialog } from '@/components/radar/ShareUrlDialog';
import { FilterBar } from '@/components/domain/FilterBar';
import { PageHeader } from '@/components/domain/PageHeader';
import { Pagination } from '@/components/domain/Pagination';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { ErrorState } from '@/components/StateMessage';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import type { RadarFeedbackCounts } from '@/components/radar/RadarFeedbackBar';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';
import { useCurrentUser } from '@/lib/auth/client';
import { SOURCE_TYPE_FILTER_OPTIONS } from '@/lib/radar/source-labels';
import { cn } from '@/lib/utils';

interface RadarCandidateListItem {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  sourceType: string | null;
  sourceName: string | null;
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

// 雷达搜索：哨兵值是空串，对应 API 的 "全部"
const ALL = '__all__';

const SOURCE_TYPE_OPTIONS = [
  { value: ALL, label: '全部来源' },
  ...SOURCE_TYPE_FILTER_OPTIONS,
];

const QUALITY_OPTIONS = [
  { value: 'collection', label: '核心材料' },
  { value: 'deep_read', label: '推荐精读' },
  { value: 'skim', label: '速览' },
];

const PAGE_SIZE_OPTIONS = [20, 50, 100, 'all'] as const;
type QualityValue = (typeof QUALITY_OPTIONS)[number]['value'];
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
// Default excludes skim so the radar list stays focused on items worth
// deep-reading. Users can still widen the filter to skim via the dropdown.
const DEFAULT_QUALITY: QualityValue[] = ['collection', 'deep_read'];

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

function RadarMultiSelect({
  label,
  ariaLabel,
  options,
  selected,
  allValue,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  selected: string[];
  allValue?: string;
  onChange: (values: string[]) => void;
}) {
  const selectedLabels = options
    .filter((option) => option.value !== allValue && selected.includes(option.value))
    .map((option) => option.label);
  const allLabel = options.find((option) => option.value === allValue)?.label ?? '全部';
  const valueLabel = selectedLabels.length > 0 ? selectedLabels.join('、') : allLabel;

  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={ariaLabel}
            title={valueLabel}
            className="h-9 min-w-36 max-w-64 justify-between gap-2 font-normal"
          >
            <span className="truncate text-foreground">{valueLabel}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {options.map((option) => {
            const isAll = option.value === allValue;
            const checked = isAll ? selected.length === 0 : selected.includes(option.value);
            return (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={checked}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(nextChecked) => {
                  if (isAll) {
                    onChange([]);
                    return;
                  }
                  const next = nextChecked
                    ? [...selected, option.value]
                    : selected.filter((value) => value !== option.value);
                  onChange(next);
                }}
              >
                {option.label}
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function RadarPage() {
  const searchParams = useSearchParams();
  const me = useCurrentUser();
  const initialQuery = searchParams.get('q') ?? '';
  const [q, setQ] = useState(initialQuery);
  const [searchInput, setSearchInput] = useState(initialQuery);
  const [sourceTypes, setSourceTypes] = useState<string[]>(() => {
    const value = searchParams.get('source') ?? '';
    return value ? value.split(',').filter(Boolean) : [];
  });
  const [quality, setQuality] = useState<QualityValue[]>(() => {
    const values = (searchParams.get('quality') ?? '').split(',').filter(
      (value): value is QualityValue => QUALITY_OPTIONS.some((option) => option.value === value),
    );
    return values.length > 0 ? values : DEFAULT_QUALITY;
  });
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const value = searchParams.get('date');
    return DATE_OPTIONS.some((option) => option.value === value) ? value as DateRange : '7d';
  });
  const [page, setPage] = useState(() => Math.max(1, Number(searchParams.get('page')) || 1));
  const [perPage, setPerPage] = useState<PageSize>(() => {
    const value = searchParams.get('per_page');
    if (value === 'all') return 'all';
    return [20, 50, 100].includes(Number(value)) ? Number(value) as PageSize : 20;
  });
  const [view, setView] = useState<'source' | 'ranked'>(
    () => searchParams.get('view') === 'source' ? 'source' : 'ranked',
  );
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const query = useQuery<RadarListResponse>({
    queryKey: ['radar', q, sourceTypes.join(','), quality.join(','), dateRange, page, perPage],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      sourceTypes.forEach((value) => params.append('sourceType', value));
      quality.forEach((value) => params.append('quality', value));
      const dateFrom = dateFromForRange(dateRange);
      if (dateFrom) params.set('dateFrom', dateFrom);
      params.set('page', String(page));
      params.set('per_page', perPage === 'all' ? 'all' : String(perPage));
      return fetchRadar(params);
    },
    placeholderData: (prev) => prev,
    enabled: view === 'ranked',
  });

  const groupedQueries = useQueries({
    queries: RADAR_GROUPS.map((group) => ({
      queryKey: ['radar-group', group.id, q, quality.join(','), dateRange],
      queryFn: () => {
        const params = new URLSearchParams({
          sourceType: group.sourceType,
          page: '1',
          per_page: '5',
        });
        quality.forEach((value) => params.append('quality', value));
        const dateFrom = dateFromForRange(dateRange);
        if (dateFrom) params.set('dateFrom', dateFrom);
        if (q) params.set('q', q);
        return fetchRadar(params);
      },
      enabled: view === 'source',
    })),
  });

  const groupedEntries = RADAR_GROUPS.map((group, index) => ({
    group,
    query: groupedQueries[index],
    items: groupedQueries[index]?.data?.items ?? [],
  }));
  const groupedIsFetching = groupedQueries.some((groupQuery) => groupQuery.isFetching);
  const visibleGroupEntries = groupedEntries.filter(({ group, query, items }) => (
    sourceTypes.length > 0
      ? sourceTypes.includes(group.sourceType)
      : query.isLoading || !query.data || items.length > 0
  ));
  const groupedTotal = visibleGroupEntries.reduce(
    (total, { query }) => total + (query.data?.total ?? 0),
    0,
  );
  const items = query.data?.items ?? [];
  const totalPages = query.data?.totalPages ?? 1;
  const dateLabel = DATE_OPTIONS.find((option) => option.value === dateRange)?.label ?? '全部时间';
  const qualityLabel = quality.length > 0
    ? QUALITY_OPTIONS.filter((option) => quality.includes(option.value)).map((option) => option.label).join('、')
    : '全部阅读等级';
  const sourceLabel = sourceTypes.length > 0
    ? SOURCE_TYPE_FILTER_OPTIONS
      .filter((option) => sourceTypes.includes(option.value))
      .map((option) => option.label)
      .join('、')
    : '全部来源';
  const resetFilters = () => {
    setSearchInput('');
    setQ('');
    setSourceTypes([]);
    setQuality(DEFAULT_QUALITY);
    setDateRange('7d');
    setPage(1);
    setPerPage(20);
  };
  const listState = new URLSearchParams({
    quality: quality.join(','),
    date: dateRange,
    page: String(page),
    per_page: String(perPage),
    view,
  });
  if (q) listState.set('q', q);
  if (sourceTypes.length > 0) listState.set('source', sourceTypes.join(','));
  const detailHref = (summaryId: string) => (
    `/radar/${summaryId}?from=${encodeURIComponent(listState.toString())}`
  );
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQ(searchInput.trim());
    setPage(1);
  };

  return (
    <div className="mx-auto min-w-0 max-w-shell">
      <PageHeader
        title="技术雷达"
        description="从最近信号中先看最值得打开的内容；也可以按来源浏览。"
        actions={(
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center rounded-lg border border-border bg-card p-1 shadow-sm" aria-label="雷达展示方式">
              <Button
                type="button"
                variant={view === 'ranked' ? 'default' : 'ghost'}
                size="sm"
                className={view === 'ranked' ? 'shadow-sm' : 'text-muted-foreground'}
                title="按推荐程度统一排序"
                aria-label="推荐先看"
                aria-pressed={view === 'ranked'}
                onClick={() => setView('ranked')}
              >
                <ListOrdered className="size-3.5" />
                推荐先看
              </Button>
              <Button
                type="button"
                variant={view === 'source' ? 'default' : 'ghost'}
                size="sm"
                className={view === 'source' ? 'shadow-sm' : 'text-muted-foreground'}
                title="按来源浏览内容"
                aria-label="按来源浏览"
                aria-pressed={view === 'source'}
                onClick={() => setView('source')}
              >
                <Layers3 className="size-3.5" />
                按来源浏览
              </Button>
            </div>
            <ShareUrlDialog />
          </div>
        )}
      />

      <FilterBar
        onSubmit={submitSearch}
        className="hidden sm:flex"
        trailing={
          view === 'ranked'
            ? query.isFetching ? '加载中…' : query.data ? `共 ${query.data.total} 条` : undefined
            : groupedIsFetching ? '加载中…' : `共 ${groupedTotal} 条`
        }
      >
        <Input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="搜索标题、解读或标签"
          aria-label="搜索雷达内容"
          className="w-full sm:w-64"
        />

        <RadarMultiSelect
          label="阅读等级"
          ariaLabel="阅读等级筛选"
          options={QUALITY_OPTIONS}
          selected={quality}
          onChange={(next) => {
            setQuality(next.length > 0 ? next as QualityValue[] : DEFAULT_QUALITY);
            setPage(1);
          }}
        />

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>入库时间</span>
          <Select
            value={dateRange}
            onValueChange={(v) => { setDateRange(v as DateRange); setPage(1); }}
          >
            <SelectTrigger className="w-32" aria-label="入库时间筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <RadarMultiSelect
          label="来源"
          ariaLabel="来源筛选"
          options={SOURCE_TYPE_OPTIONS}
          selected={sourceTypes}
          allValue={ALL}
          onChange={(next) => {
            setSourceTypes(next);
            setPage(1);
          }}
        />

        {view === 'ranked' ? (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>每页</span>
            <Select
              value={String(perPage)}
              onValueChange={(v) => { setPerPage(v === 'all' ? 'all' : Number(v) as PageSize); setPage(1); }}
            >
              <SelectTrigger className="w-24" aria-label="每页展示条数">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>{size === 'all' ? '全部' : `${size} 条`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}

        <Button type="submit" size="sm">
          <Search />
          搜索
        </Button>
      </FilterBar>

      <div className="mb-3 space-y-2 sm:hidden">
        <form onSubmit={submitSearch} className="flex items-center gap-2">
          <Input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="搜索标题、解读或标签"
            aria-label="搜索雷达内容"
            className="h-10 min-w-0 flex-1"
          />
          <Button type="submit" size="icon" className="size-10 shrink-0" aria-label="搜索雷达内容">
            <Search />
          </Button>
        </form>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <p className="min-w-0 truncate">
            {view === 'ranked' ? '推荐先看' : '按来源浏览'} · {dateLabel} · {qualityLabel}
          </p>
          <Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
            <SheetTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-9 shrink-0">
                <SlidersHorizontal />
                筛选
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto px-4 pb-6">
              <SheetHeader className="px-0">
                <SheetTitle>筛选雷达内容</SheetTitle>
                <SheetDescription>调整后立即更新结果，也可以随时重置。</SheetDescription>
              </SheetHeader>
              <div className="mt-5 grid gap-4">
                <RadarMultiSelect
                  label="阅读等级"
                  ariaLabel="阅读等级筛选"
                  options={QUALITY_OPTIONS}
                  selected={quality}
                  onChange={(next) => {
                    setQuality(next.length > 0 ? next as QualityValue[] : DEFAULT_QUALITY);
                    setPage(1);
                  }}
                />
                <label className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                  <span>入库时间</span>
                  <Select
                    value={dateRange}
                    onValueChange={(v) => { setDateRange(v as DateRange); setPage(1); }}
                  >
                    <SelectTrigger className="w-36" aria-label="入库时间筛选">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DATE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <RadarMultiSelect
                  label="来源"
                  ariaLabel="来源筛选"
                  options={SOURCE_TYPE_OPTIONS}
                  selected={sourceTypes}
                  allValue={ALL}
                  onChange={(next) => {
                    setSourceTypes(next);
                    setPage(1);
                  }}
                />
                {view === 'ranked' ? (
                  <label className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                    <span>每页</span>
                    <Select
                      value={String(perPage)}
                      onValueChange={(v) => { setPerPage(v === 'all' ? 'all' : Number(v) as PageSize); setPage(1); }}
                    >
                      <SelectTrigger className="w-36" aria-label="每页展示条数">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PAGE_SIZE_OPTIONS.map((size) => (
                          <SelectItem key={size} value={String(size)}>
                            {size === 'all' ? '全部' : `${size} 条`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                ) : null}
                <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                  <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                    <RotateCcw />
                    重置筛选
                  </Button>
                  <Button type="button" size="sm" onClick={() => setMobileFiltersOpen(false)}>
                    完成
                  </Button>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      <div className="mb-4 hidden flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border pb-3 text-xs text-muted-foreground sm:flex">
        <p className="min-w-0 truncate">
          当前范围：
          <span className="font-medium text-foreground">{view === 'ranked' ? '推荐先看' : '按来源浏览'}</span>
          {' · '}
          {dateLabel}
          {' · '}
          {qualityLabel}
          {' · '}
          {sourceLabel}
          {q ? ` · 搜索“${q}”` : ''}
        </p>
        <Button type="button" variant="ghost" size="xs" className="shrink-0" onClick={resetFilters}>
          <RotateCcw />
          重置筛选
        </Button>
      </div>

      {view === 'source' ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {visibleGroupEntries.map(({ group, query: groupQuery, items: groupItems }) => {
            const groupIndex = RADAR_GROUPS.findIndex((item) => item.id === group.id);
            const accent = ['bg-primary', 'bg-status-succeeded-fg', 'bg-status-queued-fg', 'bg-status-running-fg', 'bg-tier-noise'][groupIndex] ?? 'bg-primary';
            return (
              <section key={group.id} className="min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-sm" aria-labelledby={`radar-group-${group.id}`}>
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
                    className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
                    aria-label={`查看全部${group.title}`}
                    onClick={() => { setSourceTypes([group.sourceType]); setPage(1); setView('ranked'); }}
                  >
                    查看全部
                    <span className="tabular-nums">({groupQuery.data?.total ?? 0})</span>
                    <ArrowUpRight className="size-3" />
                  </button>
                </div>
                {groupQuery.isLoading ? (
                  <div className="grid gap-2.5 p-3">
                    {[0, 1].map((i) => <Skeleton key={i} className="h-36 w-full" />)}
                  </div>
                ) : groupQuery.isError ? (
                  <ErrorState
                    className="m-3"
                    title="这一组内容加载失败"
                    description="可以重试，或先切换到其他来源继续浏览。"
                    action={
                      <Button type="button" size="xs" variant="outline" onClick={() => void groupQuery.refetch()}>
                        重试
                      </Button>
                    }
                  />
                ) : groupItems.length === 0 ? (
                  <EmptyState
                    compact
                    title="暂无相关内容"
                    description="换一个来源或放宽筛选条件试试。"
                  />
                ) : (
                  <div className="grid gap-2.5 p-3">
                    {groupItems.map((it) => (
                      <RadarCandidateCard
                        key={it.id}
                        candidate={it}
                        detailHref={detailHref(it.id)}
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
        <EmptyState
          title="加载失败"
          description={String((query.error as Error).message)}
          action={
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              重试
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="暂无候选"
          description="雷达同步尚未产出候选；稍后再来或联系 admin 触发手动同步。"
          action={
            me.data?.role === 'admin' ? (
              <Button variant="outline" size="sm" asChild>
                <a href="/admin/radar">前往后台触发同步</a>
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          {items.map((it) => (
            <RadarCandidateCard
              key={it.id}
              candidate={it}
              detailHref={detailHref(it.id)}
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
