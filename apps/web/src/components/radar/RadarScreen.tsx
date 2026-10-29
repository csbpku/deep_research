'use client';

// /radar —— 技术雷达列表（Searchable via PostgreSQL ILIKE + Array Substring）。
//
// 功能：
//  - 搜索：标题 / 解读 / 标签（后端 ILIKE + unnest）；前端按 Form submit 触发
//  - 过滤器：sourceType（GitHub / arXiv / RSS）、quality（精读 / 速读）
//  - 分页（Pagination domain component）
//  - 标题在列表内打开文章概览；独立详情页仍支持直达和新标签页阅读

import { useQueries, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Checkbox from '@mui/material/Checkbox';
import MuiSelect from '@mui/material/Select';
import useMediaQuery from '@mui/material/useMediaQuery';
import { space } from '@deep-research/design-system';
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
import { RadarPreviewPanel } from '@/components/radar/RadarPreviewPanel';
import { ShareUrlDialog } from '@/components/radar/ShareUrlDialog';
import type { ExternalReadingDetail } from '@/components/radar/RadarExternalReadingLanding';
import { FilterBar } from '@/components/domain/FilterBar';
import { Pagination } from '@/components/domain/Pagination';
import { AppButton as Button } from '@/components/material/AppButton';
import { AppTextField as Input } from '@/components/material/AppTextField';
import { AppDrawer } from '@/components/material/AppDrawer';
import Skeleton from '@mui/material/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState, LoadingState } from '@/components/StateMessage';
import type { RadarFeedbackCounts } from '@/components/radar/RadarFeedbackBar';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';
import { useCurrentUser } from '@/lib/auth/client';
import { SOURCE_TYPE_FILTER_OPTIONS } from '@/lib/radar/source-labels';
import { radarSourceAppearance } from '@/lib/radar/source-appearance';
import styles from './radar-screen.module.css';

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
  originalKind: string | null;
  tier: string | null;
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
  { value: 'deep_read', label: '精读' },
  { value: 'skim', label: '速读' },
];

const PAGE_SIZE_OPTIONS = [20, 50, 100, 'all'] as const;
type QualityValue = (typeof QUALITY_OPTIONS)[number]['value'];
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
type RadarView = 'source' | 'ranked';

interface RadarUrlState {
  q: string;
  sourceTypes: string[];
  quality: QualityValue[];
  dateRange: DateRange;
  page: number;
  perPage: PageSize;
  view: RadarView;
  selectedId: string | null;
}

function radarUrlParams(state: RadarUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.sourceTypes.length > 0) params.set('source', state.sourceTypes.join(','));
  if (state.quality.length > 0) params.set('quality', state.quality.join(','));
  params.set('date', state.dateRange);
  params.set('page', String(state.page));
  params.set('per_page', String(state.perPage));
  params.set('view', state.view);
  if (state.selectedId) params.set('open', state.selectedId);
  return params;
}
// Keep the default stream focused on readable material; skim remains opt-in
// for users who want to browse browser-reading candidates.
const DEFAULT_QUALITY: QualityValue[] = ['deep_read'];

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
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <div className={styles.mobileField}>
      <span className={styles.minWidth}>{label}</span>
      <>
          <Button
            type="button"
            variant="outlined"
            aria-label={ariaLabel}
            title={valueLabel}
            aria-haspopup="menu"
            aria-expanded={Boolean(anchor)}
            onClick={event => setAnchor(event.currentTarget)}
            sx={{ minWidth: '144px', maxWidth: '256px', justifyContent: 'space-between' }}
          >
            <span className={styles.selectValue}>{valueLabel}</span>
            <ChevronDown className={styles.icon} />
          </Button>
        <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)} slotProps={{ paper: { className: 'material-surface', sx: { minWidth: '224px' } }, list: { 'aria-label': ariaLabel } }}>
          {options.map((option) => {
            const isAll = option.value === allValue;
            const checked = isAll ? selected.length === 0 : selected.includes(option.value);
            return (
              <MenuItem
                key={option.value}
                role="menuitemcheckbox"
                aria-checked={checked}
                onClick={() => {
                  if (isAll) {
                    onChange([]);
                    return;
                  }
                  const next = !checked
                    ? [...selected, option.value]
                    : selected.filter((value) => value !== option.value);
                  onChange(next);
                }}
              >
                <Checkbox checked={checked} size="small" tabIndex={-1} disableRipple sx={{ pointerEvents: 'none', padding: space.xs, marginRight: space.xs }} slotProps={{ input: { 'aria-hidden': true } }} />
                {option.label}
              </MenuItem>
            );
          })}
        </Menu>
      </>
    </div>
  );
}

function RadarSelect({ value, onChange, label, options }: {
  value: string; onChange: (value: string) => void; label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <MuiSelect value={value} onChange={event => onChange(event.target.value)} size="small" SelectDisplayProps={{ 'aria-label': label }} MenuProps={{ slotProps: { paper: { className: 'material-surface' } } }} sx={{ minWidth: '112px' }}>
      {options.map(option => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
    </MuiSelect>
  );
}

export default function RadarScreen() {
  const pathname = usePathname();
  const router = useRouter();
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
    const values = (searchParams.get('quality') ?? '').split(',').map((value) => value === 'collection' ? 'deep_read' : value).filter(
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
  const [view, setView] = useState<RadarView>(
    () => searchParams.get('view') === 'source' ? 'source' : 'ranked',
  );
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  // URL is the committed state for a radar view. This keeps a filtered list
  // shareable and makes a refresh reproduce the same result set.
  useEffect(() => {
    const nextQuality = (searchParams.get('quality') ?? '').split(',').map((value) => value === 'collection' ? 'deep_read' : value).filter(
      (value): value is QualityValue => QUALITY_OPTIONS.some((option) => option.value === value),
    );
    const nextDate = searchParams.get('date');
    const nextPerPage = searchParams.get('per_page');
    setQ(searchParams.get('q') ?? '');
    setSearchInput(searchParams.get('q') ?? '');
    setSourceTypes((searchParams.get('source') ?? '').split(',').filter(Boolean));
    setQuality(nextQuality.length > 0 ? nextQuality : DEFAULT_QUALITY);
    setDateRange(DATE_OPTIONS.some((option) => option.value === nextDate) ? nextDate as DateRange : '7d');
    setPage(Math.max(1, Number(searchParams.get('page')) || 1));
    setPerPage(nextPerPage === 'all'
      ? 'all'
      : [20, 50, 100].includes(Number(nextPerPage)) ? Number(nextPerPage) as PageSize : 20);
    setView(searchParams.get('view') === 'source' ? 'source' : 'ranked');
  }, [searchParams]);

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
  const resultCountLabel = view === 'ranked'
    ? query.isFetching ? '加载中…' : query.data ? `共 ${query.data.total} 条` : null
    : groupedIsFetching ? '加载中…' : `共 ${groupedTotal} 条`;
  const items = query.data?.items ?? [];
  const selectedId = searchParams.get('open');
  // A direct ?open= entry must not open a modal during desktop hydration.
  // MUI keeps the server snapshot stable, then subscribes to the real viewport.
  const isDesktop = useMediaQuery('(min-width: 1024px)', { defaultMatches: true });
  const availableItems = view === 'ranked'
    ? items
    : visibleGroupEntries.flatMap(({ items: groupItems }) => groupItems);
  const selectedItem = selectedId
    ? availableItems.find((item) => item.id === selectedId) ?? null
    : null;
  const previewQuery = useQuery<ExternalReadingDetail>({
    queryKey: ['radar-preview', selectedId, me.data?.id ?? null],
    enabled: Boolean(selectedId),
    queryFn: async () => {
      const response = await fetch(`/api/radar/${encodeURIComponent(selectedId!)}?surface=summary`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ message: '雷达详情加载失败' }));
        throw new Error(payload.message ?? '雷达详情加载失败');
      }
      return (await response.json()) as ExternalReadingDetail;
    },
    initialData: selectedItem ?? undefined,
    initialDataUpdatedAt: 0,
    staleTime: 30_000,
  });
  const totalPages = query.data?.totalPages ?? 1;
  const dateLabel = DATE_OPTIONS.find((option) => option.value === dateRange)?.label ?? '全部时间';
  const qualityLabel = quality.length > 0
    ? QUALITY_OPTIONS.filter((option) => quality.includes(option.value)).map((option) => option.label).join('、')
    : '全部阅读等级';
  const sourceSummary = sourceTypes.length === 0
    ? '全部来源'
    : sourceTypes.length === 1
      ? SOURCE_TYPE_OPTIONS.find((option) => option.value === sourceTypes[0])?.label ?? '1 个来源'
      : `${sourceTypes.length} 个来源`;
  const qualitySummary = quality.length === QUALITY_OPTIONS.length ? '全部等级' : qualityLabel;
  const mobileFilterSummary = `${dateLabel} · ${sourceSummary} · ${qualitySummary}`;
  const currentUrlState: RadarUrlState = { q, sourceTypes, quality, dateRange, page, perPage, view, selectedId };
  const replaceUrlState = useCallback((patch: Partial<RadarUrlState>) => {
    const next = { ...currentUrlState, ...patch };
    const listStateChanged = Object.keys(patch).some((key) => key !== 'selectedId');
    if (listStateChanged && !Object.prototype.hasOwnProperty.call(patch, 'selectedId')) {
      next.selectedId = null;
    }
    router.replace(`${pathname}?${radarUrlParams(next).toString()}`, { scroll: false });
  }, [currentUrlState, pathname, router]);
  const resetFilters = () => {
    const next: RadarUrlState = {
      ...currentUrlState,
      q: '',
      sourceTypes: [],
      quality: DEFAULT_QUALITY,
      dateRange: '7d',
      page: 1,
      perPage: 20,
      selectedId: null,
    };
    setSearchInput('');
    setQ('');
    setSourceTypes([]);
    setQuality(DEFAULT_QUALITY);
    setDateRange('7d');
    setPage(1);
    setPerPage(20);
    router.replace(`${pathname}?${radarUrlParams(next).toString()}`, { scroll: false });
  };
  const listState = radarUrlParams({ ...currentUrlState, selectedId: null });
  const detailHref = (summaryId: string) => (
    `/radar/${summaryId}?from=${encodeURIComponent(listState.toString())}`
  );
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuery = searchInput.trim();
    setQ(nextQuery);
    setPage(1);
    replaceUrlState({ q: nextQuery, page: 1, selectedId: null });
  };
  const openPreview = (summaryId: string) => replaceUrlState({ selectedId: summaryId });

  // 预览的键盘交接：打开后焦点进入面板并播报，Esc 关闭并把焦点还给
  // 来源标题——否则键盘用户要穿过剩下的卡片才能到"记录判断"。
  const previewTriggerRef = useRef<HTMLElement | null>(null);
  const previewPanelRef = useRef<HTMLElement | null>(null);
  const closePreview = useCallback(() => {
    const trigger = previewTriggerRef.current;
    replaceUrlState({ selectedId: null });
    // 等列表把面板卸掉再还焦点，否则焦点会落回 body。
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }, [replaceUrlState]);

  // 打开预览：记住来源标题，并把焦点交给面板（读屏用户能听到位置变化）。
  useEffect(() => {
    if (!selectedId) return;
    const trigger = document.querySelector<HTMLElement>(
      `article [data-radar-preview-trigger="${CSS.escape(selectedId)}"]`,
    );
    if (trigger) previewTriggerRef.current = trigger;
    const panel = previewPanelRef.current;
    if (!panel) return;
    const heading = panel.querySelector<HTMLElement>('h2');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus({ preventScroll: true });
  }, [selectedId, previewQuery.data]);

  // Esc 关闭预览。
  useEffect(() => {
    if (!selectedId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // 弹窗（记录判断 / Reader 提示）自己处理 Esc。
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      closePreview();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedId, closePreview]);

  const previewContent = previewQuery.isLoading && !previewQuery.data ? (
    <aside className={styles.previewState}>
      <LoadingState label="正在准备文章概览…" />
    </aside>
  ) : previewQuery.isError && !previewQuery.data ? (
    <aside className={styles.previewState}>
      <ErrorState title="文章概览加载失败" description={String((previewQuery.error as Error).message)} action={<div className={styles.row}>
        <Button variant="outlined" onClick={() => void previewQuery.refetch()}>重试</Button>
        <Button onClick={closePreview}>关闭</Button>
      </div>} />
    </aside>
  ) : previewQuery.data ? (
    <RadarPreviewPanel
      detail={previewQuery.data}
      onClose={closePreview}
      panelRef={previewPanelRef}
    />
  ) : null;

  return (
    <div className={`material-surface ${styles.screen}`}>
      <Box component="header" sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { sm: 'center' }, justifyContent: 'space-between', gap: space.lg, marginBottom: space.section }}>
        <Typography component="h1" variant="pageTitle">技术雷达</Typography>
          <div className={styles.wrapRow}>
            <div className={styles.viewSwitch} aria-label="雷达展示方式">
              <Button
                type="button"
                variant={view === 'ranked' ? 'contained' : 'text'}
                size="small"
                title="按分层评分从高到低排序；阅读等级表示当前可直接阅读的内容深度"
                aria-label="推荐排序"
                aria-pressed={view === 'ranked'}
                onClick={() => { setView('ranked'); replaceUrlState({ view: 'ranked', page: 1 }); }}
              >
                <ListOrdered className={styles.icon} />
                推荐排序
              </Button>
              <Button
                type="button"
                variant={view === 'source' ? 'contained' : 'text'}
                size="small"
                title="按来源浏览内容"
                aria-label="按来源浏览"
                aria-pressed={view === 'source'}
                onClick={() => { setView('source'); replaceUrlState({ view: 'source', page: 1 }); }}
              >
                <Layers3 className={styles.icon} />
                按来源浏览
              </Button>
            </div>
            <ShareUrlDialog />
          </div>
      </Box>

      <FilterBar
        onSubmit={submitSearch}
        desktopOnly
        trailing={
          <div className={styles.row}>
            <span>{resultCountLabel}</span>
            <Button
              type="button"
              variant="text"
              size="small"
              onClick={resetFilters}
              aria-label="重置筛选"
              title="重置筛选"
            >
              <RotateCcw className={styles.icon} />
            </Button>
          </div>
        }
      >
        <Input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="搜索标题、解读或标签"
          aria-label="搜索雷达内容"
          sx={{ width: '256px', maxWidth: '100%' }}
        />

        <RadarMultiSelect
          label="阅读等级"
          ariaLabel="阅读等级筛选"
          options={QUALITY_OPTIONS}
          selected={quality}
          onChange={(next) => {
            const nextQuality = next.length > 0 ? next as QualityValue[] : DEFAULT_QUALITY;
            setQuality(nextQuality);
            setPage(1);
            replaceUrlState({ quality: nextQuality, page: 1 });
          }}
        />

        <label className={styles.field}>
          <span>入库时间</span>
          <RadarSelect value={dateRange} onChange={(v) => { const nextDateRange = v as DateRange; setDateRange(nextDateRange); setPage(1); replaceUrlState({ dateRange: nextDateRange, page: 1 }); }} label="入库时间筛选" options={DATE_OPTIONS} />
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
            replaceUrlState({ sourceTypes: next, page: 1 });
          }}
        />

        {view === 'ranked' ? (
          <label className={styles.field}>
            <span>每页</span>
            <RadarSelect value={String(perPage)} onChange={(v) => { const nextPerPage = v === 'all' ? 'all' : Number(v) as PageSize; setPerPage(nextPerPage); setPage(1); replaceUrlState({ perPage: nextPerPage, page: 1 }); }} label="每页展示条数" options={PAGE_SIZE_OPTIONS.map(size => ({ value: String(size), label: size === "all" ? "全部" : `${size} 条` }))} />
          </label>
        ) : null}

        <Button type="submit" size="small" variant="contained">
          <Search />
          搜索
        </Button>
      </FilterBar>

      <div className={styles.mobileFilters}>
        <form onSubmit={submitSearch} className={styles.row}>
          <Input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="搜索标题、解读或标签"
            aria-label="搜索雷达内容"
            sx={{ width: 'auto', minWidth: 0, flex: 1 }}
          />
          <Button type="submit" variant="contained" size="small" aria-label="搜索雷达内容" sx={{ minHeight: '44px', minWidth: '44px', flexShrink: 0 }}>
            <Search />
          </Button>
        </form>
        <div className={styles.mobileSummary}>
          <p className={styles.summary} title={mobileFilterSummary}>
            {mobileFilterSummary}
          </p>
          <span className={styles.resultCount}>{resultCountLabel}</span>
          <>
              <Button type="button" variant="outlined" size="small" onClick={() => setMobileFiltersOpen(true)}>
                <SlidersHorizontal />
                筛选
              </Button>
            <AppDrawer open={mobileFiltersOpen} onClose={() => setMobileFiltersOpen(false)} anchor="bottom" title="筛选雷达内容" description="阅读等级、入库时间和来源筛选会立即更新结果。">
              <div className={styles.filterGrid}>
                <RadarMultiSelect
                  label="阅读等级"
                  ariaLabel="阅读等级筛选"
                  options={QUALITY_OPTIONS}
                  selected={quality}
                  onChange={(next) => {
                    const nextQuality = next.length > 0 ? next as QualityValue[] : DEFAULT_QUALITY;
                    setQuality(nextQuality);
                    setPage(1);
                    replaceUrlState({ quality: nextQuality, page: 1 });
                  }}
                />
                <label className={styles.mobileField}>
                  <span>入库时间</span>
                  <RadarSelect value={dateRange} onChange={(v) => { const nextDateRange = v as DateRange; setDateRange(nextDateRange); setPage(1); replaceUrlState({ dateRange: nextDateRange, page: 1 }); }} label="入库时间筛选" options={DATE_OPTIONS} />
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
                    replaceUrlState({ sourceTypes: next, page: 1 });
                  }}
                />
                {view === 'ranked' ? (
                  <label className={styles.mobileField}>
                    <span>每页</span>
                    <RadarSelect value={String(perPage)} onChange={(v) => { const nextPerPage = v === 'all' ? 'all' : Number(v) as PageSize; setPerPage(nextPerPage); setPage(1); replaceUrlState({ perPage: nextPerPage, page: 1 }); }} label="每页展示条数" options={PAGE_SIZE_OPTIONS.map(size => ({ value: String(size), label: size === "all" ? "全部" : `${size} 条` }))} />
                  </label>
                ) : null}
                <div className={styles.filterActions}>
                  <Button type="button" variant="text" size="small" sx={{ minHeight: '44px' }} onClick={resetFilters}>
                    <RotateCcw />
                    重置筛选
                  </Button>
                  <Button type="button" variant="contained" size="small" sx={{ minHeight: '44px' }} onClick={() => setMobileFiltersOpen(false)}>
                    完成
                  </Button>
                </div>
              </div>
            </AppDrawer>
          </>
        </div>
      </div>

      <div className={[styles.content, selectedId ? styles.withPreview : undefined].filter(Boolean).join(' ')}>
        <div className={styles.minWidth}>
        {view === 'source' ? (
        <div className={styles.groups}>
          {visibleGroupEntries.map(({ group, query: groupQuery, items: groupItems }) => {
            return (
              <section key={group.id} className={styles.group} aria-labelledby={`radar-group-${group.id}`}>
                <div className={styles.groupHeader} data-radar-source-group={group.sourceType}
                  style={{ '--radar-source-color': radarSourceAppearance(group.sourceType).color } as CSSProperties}>
                  <div className={styles.row}>
                    <div className={styles.minWidth}>
                      <h2 id={`radar-group-${group.id}`} className={styles.groupTitle}>{group.title}</h2>
                      <p className={styles.groupDescription}>{group.description}</p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="small" sx={{ flexShrink: 0 }}
                    aria-label={`查看全部${group.title}`}
                    onClick={() => { setSourceTypes([group.sourceType]); setPage(1); setView('ranked'); replaceUrlState({ sourceTypes: [group.sourceType], page: 1, view: 'ranked' }); }}
                  >
                    查看全部
                    <span className={styles.count}>({groupQuery.data?.total ?? 0})</span>
                    <ArrowUpRight className={styles.icon} />
                  </Button>
                </div>
                {groupQuery.isLoading ? (
                  <div className={styles.groupItems}>
                    {[0, 1].map((i) => <Skeleton key={i} variant="rounded" height={144} />)}
                  </div>
                ) : groupQuery.isError ? (
                  <ErrorState
                    className={styles.groupError}
                    title="这一组内容加载失败"
                    description="可以重试，或先切换到其他来源继续浏览。"
                    action={
                      <Button type="button" size="small" variant="outlined" onClick={() => void groupQuery.refetch()}>
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
                  <div className={styles.groupItems}>
                    {groupItems.map((it) => (
                      <RadarCandidateCard
                        key={it.id}
                        candidate={it}
                        detailHref={detailHref(it.id)}
                        currentUserId={me.data?.id ?? null}
                        currentUserRole={me.data?.role ?? null}
                        compact
                        onOpenPreview={openPreview}
                        selected={selectedId === it.id}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : query.isLoading ? (
        <div className={styles.skeletons}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.skeletonCard}>
              <Skeleton height={12} width={96} />
              <Skeleton height={16} width="66%" />
              <Skeleton height={12} width="100%" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <EmptyState
          title="加载失败"
          description={String((query.error as Error).message)}
          action={
            <Button variant="outlined" size="small" onClick={() => query.refetch()}>
              重试
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="当前筛选没有内容"
          description={dateRange === 'all'
            ? '试试放宽阅读等级、来源或搜索条件。'
            : `“${dateLabel}”内没有匹配内容，可以查看全部时间。`}
          action={
            dateRange !== 'all' ? (
              <Button
                type="button"
                variant="outlined"
                size="small"
                onClick={() => {
                  setDateRange('all');
                  setPage(1);
                  replaceUrlState({ dateRange: 'all', page: 1 });
                }}
              >
                查看全部时间
              </Button>
            ) : me.data?.role === 'admin' ? (
              <Button variant="outlined" size="small" component={Link} href="/admin/radar">前往后台触发同步</Button>
            ) : null
          }
        />
      ) : (
        <div className={styles.list}>
          {items.map((it) => (
            <RadarCandidateCard
              key={it.id}
              candidate={it}
              detailHref={detailHref(it.id)}
              currentUserId={me.data?.id ?? null}
              currentUserRole={me.data?.role ?? null}
              compact
              onOpenPreview={openPreview}
              selected={selectedId === it.id}
            />
          ))}
        </div>
      )}

      {view === 'ranked' ? (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={(nextPage) => { setPage(nextPage); replaceUrlState({ page: nextPage }); }}
          disabled={query.isFetching}
        />
      ) : null}
        </div>

        {selectedId ? (
          <div className={styles.preview}>
            {previewContent}
          </div>
        ) : null}
      </div>

      {!isDesktop ? (
        <AppDrawer
          open={Boolean(selectedId)}
          onClose={closePreview}
          anchor="bottom"
          title="文章概览"
          hideHeader
        >
          <div className={styles.drawerContent}>{previewContent}</div>
        </AppDrawer>
      ) : null}
    </div>
  );
}
