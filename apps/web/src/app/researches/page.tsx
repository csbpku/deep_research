'use client';

// 研究库列表页：成果 / 草稿 / 我的已发布。
//
// 功能：
//   - 成果 / 草稿 / 我的已发布三种状态视图
//   - 研究报告 / 知识卡片作为成果类型筛选
//   - 卡片：标题、标签、creationMethod 徽标、draft 标签、作者、状态
//   - 搜索：按标题 + 标签子串过滤（客户端；limit=20 时只过滤当前页）
//   - 排序：最新发布 / 最近编辑 / 标题
//   - 新建按钮 → 跳转编辑页
//   - 分页
//
// 旧的 ?tab=research / knowledge / mine / draft 继续兼容。
//
// 性能说明：搜索/排序目前是 client-side（瞬时反馈，零 API 改动）。
// 当已发布条目超过 ~500 条时，应迁移到 server-side：API 加 ?q= ?sort= 参数，
// 这一层的 filter/sort 逻辑迁移到 Prisma orderBy/where。

import React, { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownNarrowWide,
  ChevronDown,
  FilePlus2,
  Rocket,
  Search as SearchIcon,
  Star,
  Upload,
} from 'lucide-react';

import { PageHeader } from '@/components/domain/PageHeader';
import { Pagination } from '@/components/domain/Pagination';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { TagChip, TagList } from '@/components/domain/TagChip';
import { FilterBar } from '@/components/domain/FilterBar';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState, LoadingState } from '@/components/StateMessage';
import { AppButton as Button } from '@/components/material/AppButton';
import { AppTextField as Input } from '@/components/material/AppTextField';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import Select from '@mui/material/Select';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Paper from '@mui/material/Paper';
import { DraftActionsMenu } from '@/components/research/DraftActionsMenu';
import { ResearchStatusActionButton } from '@/components/research/ResearchStatusActionButton';
import styles from './researches.module.css';
import { cleanResearchText } from '@/lib/research-markdown-cleanup';
import { ApiHttpError, toApiHttpError } from '@/lib/errors/api-error';
import { retryOnceAi } from '@/lib/errors/friendly';
import {
  parseResearchTab,
  researchTypeForTab,
  researchTabHref,
  researchViewForTab,
  type ResearchView,
} from '@/lib/research-tabs';

interface ResearchItem {
  id: string;
  type: string;
  status: string;
  title: string;
  body: string;
  tags: string[];
  authorId: string;
  creationMethod: string;
  aiAssisted: boolean;
  publishedAt: string | null;
  featuredAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: { id: string; name: string };
  canEdit?: boolean;
}

interface ListResponse {
  items: ResearchItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const TABS = [
  { value: 'published', label: '成果' },
  { value: 'draft', label: '草稿' },
  { value: 'mine', label: '我的已发布' },
] as const;
const TYPE_FILTERS = [
  { value: 'all', label: '全部类型' },
  { value: 'research', label: '研究报告' },
  { value: 'knowledge', label: '知识卡片' },
] as const;
type ResearchTypeFilter = (typeof TYPE_FILTERS)[number]['value'];

const SORTS = [
  { key: 'newest', label: '最新发布' },
  { key: 'updated', label: '最近编辑' },
  { key: 'title', label: '按标题' },
] as const;
type SortKey = (typeof SORTS)[number]['key'];

export default function ResearchesPage() {
  return (
    <Suspense
      fallback={
        <div className={styles.screen}>
          <Skeleton variant="text" height={32} width={160} />
          <Skeleton variant="rounded" height={36} />
          <Skeleton variant="rounded" height={96} sx={{ mt: 2 }} />
        </div>
      }
    >
      <ResearchesContent />
    </Suspense>
  );
}

function ResearchesContent() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const hasExplicitTab = searchParams.has('tab');
  const tab = parseResearchTab(tabParam);
  const view = researchViewForTab(tab);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');
  const [type, setType] = useState<ResearchTypeFilter>(() => (
    hasExplicitTab ? researchTypeForTab(tab) : 'all'
  ));
  const [loadingElapsed, setLoadingElapsed] = useState(0);
  const [addMenuAnchor, setAddMenuAnchor] = useState<HTMLElement | null>(null);

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery<ListResponse>({
    queryKey: ['researches', view, type, page],
    queryFn: async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 12_000);
      const params = new URLSearchParams({
        scope: tab === 'draft' ? 'draft' : tab === 'mine' ? 'mine' : 'published',
        page: String(page),
        limit: '20',
      });
      if (type !== 'all') params.set('type', type);
      try {
        const res = await fetch(`/api/researches?${params}`, { signal: controller.signal });
        if (!res.ok) throw await toApiHttpError(res, '研究库暂时无法读取。');
        return res.json();
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') {
          throw new Error('读取研究库超时，请重试。');
        }
        throw cause;
      } finally {
        window.clearTimeout(timeout);
      }
    },
    retry: (count, cause) => !(cause instanceof ApiHttpError && cause.status === 401) && retryOnceAi(count, cause),
    refetchOnMount: (query) => !(query.state.error instanceof ApiHttpError && query.state.error.status === 401),
    refetchOnWindowFocus: (query) => !(query.state.error instanceof ApiHttpError && query.state.error.status === 401),
    refetchOnReconnect: (query) => !(query.state.error instanceof ApiHttpError && query.state.error.status === 401),
  });
  const loginRequired = isError && error instanceof ApiHttpError && error.status === 401;
  const callbackUrl = `/researches${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;

  useEffect(() => {
    if (!isLoading) {
      setLoadingElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setLoadingElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isLoading]);

  useEffect(() => {
    setType(hasExplicitTab ? researchTypeForTab(tab) : 'all');
    setPage(1);
    setQ('');
  }, [hasExplicitTab, tab, tabParam]);

  // 客户端过滤 + 排序。
  // 注意：搜索 `q` 在 reset page 时回到 1；切 tab 时已经重置过 page。
  const visible = useMemo(() => {
    if (!data) return [] as ResearchItem[];
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? data.items.filter((it) =>
          it.title.toLowerCase().includes(needle) ||
          it.tags.some((t) => t.toLowerCase().includes(needle)),
        )
      : data.items;
    const sorted = [...filtered];
    if (sort === 'newest') {
      sorted.sort((a, b) => {
        const ta = a.publishedAt ?? a.createdAt;
        const tb = b.publishedAt ?? b.createdAt;
        return tb.localeCompare(ta);
      });
    } else if (sort === 'updated') {
      sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } else {
      sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans'));
    }
    return sorted;
  }, [data, q, sort]);

  // 过滤掉所有条目时，给用户更明确的反馈
  const filteredOut = !!data && visible.length === 0 && data.items.length > 0;

  return (
    <div className={`material-surface ${styles.screen}`}>
      <PageHeader
        title="研究库"
        description="集中管理研究成果、个人草稿和已发布内容。"
        actions={
          <>
            <Button component={Link} href="/ai-research" variant="contained">
              <Rocket aria-hidden />
              开始 AI 调研
            </Button>
            <Button id="research-add-trigger" variant="outlined" aria-haspopup="menu"
              aria-controls={addMenuAnchor ? 'research-add-menu' : undefined}
              aria-expanded={Boolean(addMenuAnchor)} onClick={event => setAddMenuAnchor(event.currentTarget)}>
              添加内容 <ChevronDown aria-hidden />
            </Button>
            <Menu id="research-add-menu" anchorEl={addMenuAnchor} open={Boolean(addMenuAnchor)}
              onClose={() => setAddMenuAnchor(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              slotProps={{ list: { 'aria-labelledby': 'research-add-trigger' }, paper: { className: 'material-surface' } }}>
              <MenuItem component={Link} href="/researches/new?mode=blank" onClick={() => setAddMenuAnchor(null)}>
                <FilePlus2 size={16} aria-hidden className={styles.menuIcon} />空白草稿
              </MenuItem>
              <MenuItem component={Link} href="/researches/import" onClick={() => setAddMenuAnchor(null)}>
                <Upload size={16} aria-hidden className={styles.menuIcon} />导入文件
              </MenuItem>
            </Menu>
          </>
        }
      />

      <div className={styles.content}>
      <Tabs aria-label="研究库状态" variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
        value={view} selectionFollowsFocus
        onChange={(_event, v: ResearchView) => {
          router.replace(researchTabHref(v as ResearchView), { scroll: false });
          setPage(1);
          setQ('');
          setType('all');
        }}
      >
          {TABS.map((t) => (
            <Tab key={t.value} value={t.value} label={t.label} id={`research-view-${t.value}`} aria-controls="research-library-panel" />
          ))}
      </Tabs>
      <div id="research-library-panel" role="tabpanel" tabIndex={0}
        aria-labelledby={`research-view-${view}`} aria-busy={isFetching} className={styles.panel}>

      <FilterBar
        onSubmit={(e) => e.preventDefault()}
        trailing={
          q || sort !== 'newest' || type !== 'all' ? (
            <span className={styles.filteredCount}>
              <ArrowDownNarrowWide size={12} aria-hidden />
              {visible.length} / {data?.items.length ?? 0}
            </span>
          ) : null
        }
      >
          <div className={styles.search}>
            <SearchIcon aria-hidden />
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索标题或标签…"
              aria-label="搜索研究库"
              sx={{ '& input': { paddingLeft: '36px' } }}
            />
          </div>
          <FormControl size="small" className={styles.select}>
            <InputLabel id="research-sort-label">排序方式</InputLabel>
            <Select value={sort} labelId="research-sort-label" label="排序方式" onChange={event => setSort(event.target.value as SortKey)}>
              {SORTS.map((s) => (
                <MenuItem key={s.key} value={s.key}>
                  {s.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" className={styles.select}>
            <InputLabel id="research-type-label">内容类型</InputLabel>
            <Select value={type} labelId="research-type-label" label="内容类型" onChange={event => setType(event.target.value as ResearchTypeFilter)}>
              {TYPE_FILTERS.map((item) => (
                <MenuItem key={item.value} value={item.value}>
                  {item.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
      </FilterBar>

      <div className={styles.results}>
        {isLoading && (
          <div className={styles.loading} aria-busy="true">
            <LoadingState
              label={
                loadingElapsed >= 5
                  ? '研究库响应较慢，仍在读取内容…'
                  : '正在加载研究库…'
              }
            />
            <div className={styles.list}>
            {[0, 1, 2].map((i) => (
              <Paper key={i} variant="outlined" className={styles.card} aria-hidden>
                <Skeleton variant="text" height={16} width={80} />
                <Skeleton variant="text" height={24} width="50%" />
                <Skeleton variant="text" height={20} />
              </Paper>
            ))}
            </div>
            {loadingElapsed >= 8 ? (
              <div className={styles.slowLoading}>
                <span>等待时间较长，可以重新读取。</span>
                <Button type="button" variant="outlined" onClick={() => void refetch()}>
                  重新读取
                </Button>
              </div>
            ) : null}
          </div>
        )}

        {loginRequired ? (
          <Alert severity="info" action={
            <Button component={Link} href={`/signin?${new URLSearchParams({ callbackUrl })}`} variant="outlined">
              登录
            </Button>
          }>
            登录后查看研究库。
          </Alert>
        ) : isError ? (
          <ErrorState
            title="研究库暂时无法加载"
            description={isError ? errorMessage(error) : '请稍后重试；如果问题持续，请刷新页面。'}
            action={
              <Button type="button" variant="outlined" onClick={() => void refetch()}>
                重试
              </Button>
            }
          />
        ) : null}

        {!loginRequired && data && data.items.length === 0 && (
          <EmptyState
            title={
              view === 'draft'
                ? '暂无草稿'
                : view === 'mine'
                  ? '暂无我的已发布'
                  : type === 'all'
                    ? '暂无成果'
                    : `暂无${type === 'research' ? '研究报告' : '知识卡片'}`
            }
            description={
              view === 'draft'
                ? 'AI 调研生成的草稿会出现在这里。'
                : view === 'mine'
                  ? '你发布或归档的研究成果会出现在这里。'
                  : '发布后的内容会出现在这里。'
            }
            action={
              view === 'draft' ? (
                <Button component={Link} href="/ai-research" variant="contained">
                  <Rocket aria-hidden />开始 AI 调研
                </Button>
              ) : undefined
            }
          />
        )}

        {!loginRequired && filteredOut && (
          <EmptyState
            title="没有匹配项"
            description={q ? `没有标题或标签包含「${q}」的调研。试试别的关键词，或清空搜索。` : '当前排序下没有内容。'}
          />
        )}

        <div className={styles.list} hidden={filteredOut}>
          {!loginRequired && visible.map((item) => (
            <Paper component="article" variant="outlined"
              key={item.id}
              className={styles.card}
            >
                <div className={styles.cardHeader}>
                  <div className={styles.badges}>
                    <StatusBadge kind="method" value={item.creationMethod} />
                    {item.status === 'draft' && <StatusBadge kind="research" value="draft" />}
                    {item.featuredAt && <StatusBadge kind="featured" value="true" icon={<Star aria-hidden />} />}
                  </div>
                    {view === 'draft' ? (
                    <DraftActionsMenu
                      researchId={item.id}
                      title={item.title}
                      onDeleted={() => queryClient.invalidateQueries({ queryKey: ['researches', 'draft'] })}
                    />
                  ) : item.canEdit && item.status !== 'draft' ? (
                    <ResearchStatusActionButton
                      researchId={item.id}
                      title={item.title}
                      status={item.status === 'archived' ? 'archived' : 'published'}
                      compact
                      className={styles.statusAction}
                      onChanged={() => queryClient.invalidateQueries({ queryKey: ['researches'] })}
                    />
                  ) : null}
                </div>

                <Link
                  href={`/researches/${item.id}`}
                  className={styles.cardLink}
                >
                  <h2 className={styles.title}>
                    {item.title}
                  </h2>

                  <p className={styles.excerpt}>
                    {excerpt(item.body, 200)}
                  </p>

                  {item.tags.length > 0 && (
                    <TagList className={styles.tags}>
                      {item.tags.map((t) => (
                        <TagChip key={t}>{t}</TagChip>
                      ))}
                    </TagList>
                  )}

                  <div className={styles.metadata}>
                    <span>{item.author.name}</span>
                    <span>
                      {view === 'draft'
                        ? `更新 ${new Date(item.updatedAt).toLocaleDateString('zh-CN')}`
                        : `发布 ${new Date(item.publishedAt ?? item.createdAt).toLocaleDateString('zh-CN')}`}
                    </span>
                  </div>
                </Link>
            </Paper>
          ))}
        </div>

        {!loginRequired && <Pagination
          page={page}
          totalPages={data?.totalPages ?? 1}
          onPageChange={setPage}
          disabled={isFetching}
        />}
      </div>
      </div>
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : '请稍后重试；如果问题持续，请刷新页面。';
}

function excerpt(body: string, max: number): string {
  const plainText = cleanResearchText(body)
    .replace(/[#*`>\-\[\]()!_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plainText.length <= max) return plainText;
  return plainText.slice(0, max) + '...';
}
