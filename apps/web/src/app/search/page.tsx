'use client';

// /search — 全文搜索结果页。
//
// 行为：
//   - 顶部搜索框：保留 query string（刷新不丢）
//   - 按 type 分组 tab（全部 / 雷达 / 摘要 / 长文 / 精华）
//   - 每条结果：type 标签 + 标题（链接到详情）+ 高亮 snippet
//   - 未登录：服务端 redirect 到 signin
//
// 设计：
//   - 客户端发起 GET /api/search?q=&type=&page=&per_page=
//   - 高亮来自后端 ts_headline（已用 <mark>...</mark> 包裹匹配段）
//   - 切 tab 时：把 ?type 写到 query string；前端不刷页面，只更新 state

import { useCallback, useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Search as SearchIcon } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/domain/PageHeader';
import { Pagination } from '@/components/domain/Pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';

interface SearchRow {
  id: string;
  type: 'summary' | 'long_research' | 'knowledge' | 'radar';
  refId: string;
  title: string;
  snippet: string;
  highlighted: string;
  publishedAt: string;
  rank: number;
}

interface SearchResponse {
  items: SearchRow[];
  total: number;
  page: number;
  per_page: number;
  totalPages: number;
}

// Radix Tabs 的 value 不能是空串，用 all 哨兵；发请求时映射回空。
const ALL = 'all';

const TYPE_TABS: Array<{ key: string; label: string }> = [
  { key: ALL, label: '全部' },
  { key: 'radar', label: '雷达' },
  { key: 'summary', label: '摘要' },
  { key: 'long_research', label: '长文' },
  { key: 'knowledge', label: '精华' },
];

const TYPE_BADGE: Record<SearchRow['type'], { label: string; className: string }> = {
  radar: { label: '雷达', className: 'bg-radar-candidate-bg text-radar-candidate-fg' },
  summary: { label: '摘要', className: 'bg-radar-published-bg text-radar-published-fg' },
  long_research: { label: '长文', className: 'bg-status-running-bg text-status-running-fg' },
  knowledge: { label: '精华', className: 'bg-status-queued-bg text-status-queued-fg' },
};

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-shell space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-9 w-full" />
        </div>
      }
    >
      <SearchContent />
    </Suspense>
  );
}

function SearchContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialQ = searchParams.get('q') ?? '';
  const initialType = searchParams.get('type') || ALL;
  const initialPage = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);

  const [q, setQ] = useState(initialQ);
  const [submittedQ, setSubmittedQ] = useState(initialQ);
  const [type, setType] = useState<string>(initialType);
  const [page, setPage] = useState(initialPage);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detailHref = useCallback((row: SearchRow) => {
    if (row.type === 'radar') return `/radar/${row.refId}`;
    if (row.type === 'summary') return `/summaries/${row.refId}`;
    return `/researches/${row.refId}`;
  }, []);

  // 同步 query string（不刷页面，仅 router.replace）
  useEffect(() => {
    const params = new URLSearchParams();
    if (submittedQ) params.set('q', submittedQ);
    if (type !== ALL) params.set('type', type);
    if (page > 1) params.set('page', String(page));
    const qs = params.toString();
    router.replace(qs ? `/search?${qs}` : '/search');
  }, [submittedQ, type, page, router]);

  // 拉取结果
  useEffect(() => {
    if (!submittedQ) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('q', submittedQ);
    if (type !== ALL) params.set('type', type);
    params.set('page', String(page));
    params.set('per_page', '20');
    fetch(`/api/search?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<SearchResponse>;
      })
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '搜索失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [submittedQ, type, page]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setSubmittedQ(q.trim());
      setPage(1);
    },
    [q],
  );

  const totalPages = data?.totalPages ?? 0;
  const items = data?.items ?? [];

  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title="搜索"
        description="跨雷达、摘要与调研库检索；标题优先，兼顾词组和近似匹配。"
      />

      <form onSubmit={handleSubmit} className="mb-4 flex gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='例如 "RAG 评估" OR GraphRAG'
          aria-label="搜索关键词"
          className="flex-1"
        />
        <Button type="submit" disabled={loading || !q.trim()}>
          <SearchIcon />
          {loading ? '搜索中…' : '搜索'}
        </Button>
      </form>

      <Tabs
        value={type}
        onValueChange={(v) => {
          setType(v);
          setPage(1);
        }}
      >
        <TabsList className="w-full justify-start">
          {TYPE_TABS.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="mt-4">
        {error && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {!submittedQ && (
          <EmptyState title="开始搜索" description="输入关键词以搜索雷达、摘要、长文和精华。" />
        )}

        {loading && (
          <div className="grid gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2 rounded-lg border border-border bg-card p-3.5">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        )}

        {submittedQ && !loading && data && items.length === 0 && (
          <EmptyState title="没有匹配的内容" description="换个关键词，或切换到其他类型再试。" />
        )}

        {data && items.length > 0 && (
          <>
            <p className="mb-2 text-xs tabular-nums text-muted-foreground">
              共 {data.total} 条结果
            </p>
            <ul className="grid list-none gap-2.5 p-0">
              {items.map((row) => {
                const badge = TYPE_BADGE[row.type];
                return (
                  <li key={row.id}>
                    <Card className="transition-colors duration-200 hover:border-primary/40">
                      <CardContent className="p-3.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
                          >
                            {badge.label}
                          </span>
                          <Link
                            href={detailHref(row)}
                            className="text-sm font-medium hover:text-primary hover:underline"
                          >
                            {row.title}
                          </Link>
                        </div>
                        {/* highlighted snippet —— 后端用 <mark> 包裹全文匹配段，
                            并在返回前转义来源文本，只保留高亮标签。 */}
                        <p
                          className="mt-1.5 text-sm leading-relaxed text-muted-foreground [&_mark]:rounded-sm [&_mark]:bg-status-queued-bg [&_mark]:px-0.5 [&_mark]:text-status-queued-fg"
                          dangerouslySetInnerHTML={{ __html: row.highlighted }}
                        />
                        <div className="mt-1.5 font-mono text-xs tabular-nums text-muted-foreground">
                          {new Date(row.publishedAt).toLocaleString('zh-CN')}
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </ul>

            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
              disabled={loading}
            />
          </>
        )}
      </div>
    </div>
  );
}
