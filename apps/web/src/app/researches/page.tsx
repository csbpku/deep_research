'use client';

// 调研库列表页：research / knowledge tab 切换。
//
// 功能：
//   - 长文 (research) / 精华 (knowledge) / 我的草稿 tab
//   - 卡片：标题、标签、creationMethod 徽标、draft 标签、作者、状态
//   - 搜索：按标题 + 标签子串过滤（客户端；limit=20 时只过滤当前页）
//   - 排序：最新发布 / 最近编辑 / 标题
//   - 新建按钮 → 跳转编辑页
//   - 分页
//
// ⚠️ e2e 断言正文含 /调研库|researches/，勿改标题文案。
//
// 性能说明：搜索/排序目前是 client-side（瞬时反馈，零 API 改动）。
// 当已发布条目超过 ~500 条时，应迁移到 server-side：API 加 ?q= ?sort= 参数，
// 这一层的 filter/sort 逻辑迁移到 Prisma orderBy/where。

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownNarrowWide, ArrowUpDown, Plus, Search as SearchIcon, Wand2 } from 'lucide-react';

import { PageHeader } from '@/components/domain/PageHeader';
import { Pagination } from '@/components/domain/Pagination';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { TagChip, TagList } from '@/components/domain/TagChip';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { DeleteDraftButton } from '@/components/research/DeleteDraftButton';
import { cn } from '@/lib/utils';
import {
  parseResearchTab,
  researchTabHref,
  type ResearchTab,
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
  createdAt: string;
  author: { id: string; name: string };
}

interface ListResponse {
  items: ResearchItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const TABS: Array<{ value: ResearchTab; label: string }> = [
  { value: 'research', label: '研究报告' },
  { value: 'knowledge', label: '知识卡片' },
  { value: 'draft', label: '我的草稿' },
];

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
  const tab = parseResearchTab(searchParams.get('tab'));
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');

  const { data, isLoading, isError, isFetching } = useQuery<ListResponse>({
    queryKey: ['researches', tab, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        scope: tab === 'draft' ? 'draft' : 'published',
        page: String(page),
        limit: '20',
      });
      if (tab !== 'draft') params.set('type', tab);
      const res = await fetch(`/api/researches?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
  });

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
      sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } else {
      sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans'));
    }
    return sorted;
  }, [data, q, sort]);

  // 过滤掉所有条目时，给用户更明确的反馈
  const filteredOut = !!data && visible.length === 0 && data.items.length > 0;

  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title="调研库"
        description="完整研究报告与讨论知识卡片的长期归档。"
        actions={
          <Button asChild size="sm">
            <Link href="/researches/new">
              <Plus />
              新建
            </Link>
          </Button>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(v) => {
          router.replace(researchTabHref(v as ResearchTab), { scroll: false });
          setPage(1);
          setQ('');
        }}
      >
        <TabsList className="w-full justify-start">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* 过滤条 —— 仅在 published tab 显示（草稿通常不需要按标题搜） */}
      {tab !== 'draft' && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px] sm:max-w-md">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索标题或标签…"
              aria-label="搜索调研库"
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
          {(q || sort !== 'newest') && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              <ArrowDownNarrowWide className="mr-1 inline size-3 align-text-bottom" />
              {visible.length} / {data?.items.length ?? 0}
            </span>
          )}
        </div>
      )}

      <div className="mt-4">
        {isLoading && (
          <div className="grid gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2 rounded-md border border-border bg-card p-4">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        )}

        {isError && <EmptyState title="加载失败" description="请稍后重试。" />}

        {data && data.items.length === 0 && (
          <EmptyState
            title={tab === 'draft' ? '暂无草稿' : `暂无${tab === 'research' ? '研究报告' : '知识卡片'}`}
            description={
              tab === 'draft' ? '新建或由 AI 调研产出的草稿会出现在这里。' : '发布后的内容会出现在这里。'
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
                    {item.aiAssisted && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-method-ai/40 px-2 py-0.5 text-xs text-method-ai">
                        <Wand2 className="size-3" />
                        AI 协助
                      </span>
                    )}
                    {item.status === 'draft' && <StatusBadge kind="research" value="draft" />}
                  </div>
                  {tab === 'draft' ? (
                    <DeleteDraftButton
                      researchId={item.id}
                      title={item.title}
                      compact
                      className="ml-auto shrink-0"
                      onDeleted={() => queryClient.invalidateQueries({ queryKey: ['researches', 'draft'] })}
                    />
                  ) : null}
                </div>

                <Link
                  href={`/researches/${item.id}`}
                  className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <h2 className="text-sm font-semibold leading-snug">{item.title}</h2>

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
                      {new Date(item.publishedAt ?? item.createdAt).toLocaleDateString('zh-CN')}
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
    </div>
  );
}

function excerpt(body: string, max: number): string {
  const plainText = body.replace(/[#*`>\-\[\]()!_~|]/g, '').replace(/\s+/g, ' ').trim();
  if (plainText.length <= max) return plainText;
  return plainText.slice(0, max) + '...';
}
