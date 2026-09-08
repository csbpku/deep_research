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

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownNarrowWide,
  ArrowUpDown,
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
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { DraftActionsMenu } from '@/components/research/DraftActionsMenu';
import { ResearchStatusActionButton } from '@/components/research/ResearchStatusActionButton';
import { cn } from '@/lib/utils';
import { cleanResearchText } from '@/lib/research-markdown-cleanup';
import {
  parseResearchTab,
  researchTypeForTab,
  researchTabHref,
  researchViewForTab,
  type ResearchTab,
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
        <div className="mx-auto max-w-shell space-y-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-24 w-full" />
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
        if (!res.ok) throw new Error('研究库暂时无法读取。');
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
  });

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
    <div className="mx-auto w-full max-w-shell">
      <PageHeader
        title="研究库"
        description="集中管理研究成果、个人草稿和已发布内容。"
        actions={
          <>
            <Button asChild size="sm">
              <Link href="/ai-research">
                <Rocket />
                开始 AI 调研
              </Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  添加内容
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link href="/researches/new?mode=blank">
                    <FilePlus2 />
                    空白草稿
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/researches/import">
                    <Upload />
                    导入文件
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <Tabs
        value={view}
        onValueChange={(v) => {
          router.replace(researchTabHref(v as ResearchView), { scroll: false });
          setPage(1);
          setQ('');
          setType('all');
        }}
        className="w-full max-w-6xl"
      >
        <TabsList className="w-full justify-start overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={view} className="mt-3 space-y-3 focus-visible:outline-none">

      <FilterBar
        onSubmit={(e) => e.preventDefault()}
        trailing={
          q || sort !== 'newest' || type !== 'all' ? (
            <span>
              <ArrowDownNarrowWide className="mr-1 inline size-3 align-text-bottom" />
              {visible.length} / {data?.items.length ?? 0}
            </span>
          ) : null
        }
      >
          <div className="relative min-w-[200px] flex-1 sm:max-w-md">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索标题或标签…"
              aria-label="搜索研究库"
              className="pl-9"
            />
          </div>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="w-36" aria-label="排序方式">
              <ArrowUpDown className="size-3" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={type} onValueChange={(v) => setType(v as ResearchTypeFilter)}>
            <SelectTrigger className="w-36" aria-label="内容类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPE_FILTERS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
      </FilterBar>

      <div className="mt-4">
        {isLoading && (
          <div className="space-y-3" aria-busy="true">
            <LoadingState
              label={
                loadingElapsed >= 5
                  ? '研究库响应较慢，仍在读取内容…'
                  : '正在加载研究库…'
              }
            />
            <div className="grid gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className={cn('space-y-2 rounded-md border border-border bg-card p-4', i === 2 && 'hidden sm:block')}>
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
            </div>
            {loadingElapsed >= 8 ? (
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>等待时间较长，可以重新读取。</span>
                <Button type="button" size="xs" variant="outline" onClick={() => void refetch()}>
                  重新读取
                </Button>
              </div>
            ) : null}
          </div>
        )}

        {isError && (
          <ErrorState
            title="研究库暂时无法加载"
            description={isError ? errorMessage(error) : '请稍后重试；如果问题持续，请刷新页面。'}
            action={
              <Button type="button" size="xs" variant="outline" onClick={() => void refetch()}>
                重试
              </Button>
            }
          />
        )}

        {data && data.items.length === 0 && (
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
                <Button asChild size="sm">
                  <Link href="/ai-research">
                    <Rocket />
                    开始 AI 调研
                  </Link>
                </Button>
              ) : undefined
            }
          />
        )}

        {filteredOut && (
          <EmptyState
            title="没有匹配项"
            description={q ? `没有标题或标签包含「${q}」的调研。试试别的关键词，或清空搜索。` : '当前排序下没有内容。'}
          />
        )}

        <div className={cn('grid gap-3', filteredOut && 'hidden')}>
          {visible.map((item) => (
            <Card
              key={item.id}
              className="group transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-sm"
            >
              <CardContent className="p-4">
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                    <StatusBadge kind="method" value={item.creationMethod} />
                    {item.status === 'draft' && <StatusBadge kind="research" value="draft" />}
                    {item.featuredAt && <StatusBadge kind="featured" value="true" icon={<Star />} />}
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
                      className="ml-auto shrink-0"
                      onChanged={() => queryClient.invalidateQueries({ queryKey: ['researches'] })}
                    />
                  ) : null}
                </div>

                <Link
                  href={`/researches/${item.id}`}
                  className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <h2 className="line-clamp-2 break-words text-base font-semibold leading-snug tracking-normal">
                    {item.title}
                  </h2>

                  <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                    {excerpt(item.body, 200)}
                  </p>

                  {item.tags.length > 0 && (
                    <TagList className="mt-2.5">
                      {item.tags.map((t) => (
                        <TagChip key={t}>{t}</TagChip>
                      ))}
                    </TagList>
                  )}

                  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                    <span>{item.author.name}</span>
                    <span className="font-mono tabular-nums">
                      {view === 'draft'
                        ? `更新 ${new Date(item.updatedAt).toLocaleDateString('zh-CN')}`
                        : `发布 ${new Date(item.publishedAt ?? item.createdAt).toLocaleDateString('zh-CN')}`}
                    </span>
                  </div>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>

        <Pagination
          page={page}
          totalPages={data?.totalPages ?? 1}
          onPageChange={setPage}
          disabled={isFetching}
        />
      </div>
        </TabsContent>
      </Tabs>
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
