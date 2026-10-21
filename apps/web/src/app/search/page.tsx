'use client';

// /search — 全文搜索结果页。
//
// 行为：
//   - 顶部搜索框：保留 query string（刷新不丢）
//   - 按 type 分组 tab（全部 / 雷达 / 摘要 / 长文 / 精华）
//   - 每条结果：type 标签 + 标题（链接到详情）+ 高亮 snippet
//   - 未登录只搜索公开内容；本人草稿由 API 按服务端身份过滤
//
// 设计：
//   - 客户端发起 GET /api/search?q=&type=&page=&per_page=
//   - 高亮来自后端 ts_headline（已用 <mark>...</mark> 包裹匹配段）
//   - 切 tab 时：把 ?type 写到 query string；前端不刷页面，只更新 state

import React, { useCallback, useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Search as SearchIcon } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/StateMessage';
import { PageHeader } from '@/components/domain/PageHeader';
import { Pagination } from '@/components/domain/Pagination';
import { AppButton as Button } from '@/components/material/AppButton';
import { AppTextField as Input } from '@/components/material/AppTextField';
import Skeleton from '@mui/material/Skeleton';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Paper from '@mui/material/Paper';
import Chip from '@mui/material/Chip';
import styles from './search.module.css';

interface SearchRow {
  id: string;
  type: 'summary' | 'long_research' | 'knowledge' | 'radar';
  refId: string;
  title: string;
  snippet: string;
  highlighted: string;
  publishedAt: string;
  rank: number;
  isPrivate: boolean;
}

interface SearchResponse {
  items: SearchRow[];
  total: number;
  page: number;
  per_page: number;
  totalPages: number;
}

// Preserve the existing URL/API contract: all is omitted from requests.
const ALL = 'all';

const TYPE_TABS: Array<{ key: string; label: string }> = [
  { key: ALL, label: '全部' },
  { key: 'radar', label: '雷达' },
  { key: 'summary', label: '摘要' },
  { key: 'long_research', label: '研究报告' },
  { key: 'knowledge', label: '知识卡片' },
];

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className={styles.screen}>
          <Skeleton variant="text" width={160} height={32} />
          <Skeleton variant="rounded" height={36} />
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

  // The URL is the committed search state. Keeping a second submittedQ/type/
  // page state here allowed a navigation (back/forward, a pasted URL, or a
  // router refresh) to leave the visible result set one query behind.
  const submittedQ = searchParams.get('q') ?? '';
  const type = searchParams.get('type') || ALL;
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const [q, setQ] = useState(submittedQ);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState(0);

  // Preserve an in-progress edit while changing tabs, but restore the input
  // when the committed query itself changes through navigation or refresh.
  useEffect(() => {
    setQ(submittedQ);
  }, [submittedQ]);

  const replaceSearch = useCallback((next: {
    q?: string;
    type?: string;
    page?: number;
  }) => {
    const params = new URLSearchParams();
    const nextQ = next.q ?? submittedQ;
    const nextType = next.type ?? type;
    const nextPage = next.page ?? page;
    if (nextQ) params.set('q', nextQ);
    if (nextType !== ALL) params.set('type', nextType);
    if (nextPage > 1) params.set('page', String(nextPage));
    const qs = params.toString();
    router.replace(qs ? `/search?${qs}` : '/search');
  }, [page, router, submittedQ, type]);

  const detailHref = useCallback((row: SearchRow) => {
    const base = row.type === 'radar'
      ? `/radar/${row.refId}`
      : row.type === 'summary'
        ? `/radar/${row.refId}`
        : `/researches/${row.refId}`;
    /* 详情页跳转契约:?returnTo=/search?...(同源、必须以 /search 开头)
   消费方:BackToSearchButton 读取并校验 startsWith('/search'),避免开放重定向
   链接会完整带 q/type/page 参数,详情页 BackToSearchButton 点击后还原 */
    const currentSearch = searchParams.toString();
    const returnTo = `/search${currentSearch ? `?${currentSearch}` : ''}`;
    return `${base}?returnTo=${encodeURIComponent(returnTo)}`;
  }, [searchParams]);

  // 拉取结果
  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    if (!submittedQ) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    // Do not leave a previous query's rows visible while the new query is in
    // flight. AbortController also prevents a slow response from consuming
    // the browser connection and complements the active guard for runtimes
    // that do not abort a fetch immediately.
    setData(null);
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('q', submittedQ);
    if (type !== ALL) params.set('type', type);
    params.set('page', String(page));
    params.set('per_page', '20');
    fetch(`/api/search?${params.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<SearchResponse>;
      })
      .then((body) => {
        if (active) setData(body);
      })
      .catch((err) => {
        if (!active || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err instanceof Error ? err.message : '搜索失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [submittedQ, type, page, requestKey]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      replaceSearch({ q: q.trim(), page: 1 });
    },
    [q, replaceSearch],
  );

  const totalPages = data?.totalPages ?? 0;
  const items = data?.items ?? [];
  const selectedType = TYPE_TABS.some(tab => tab.key === type) ? type : false;

  return (
    <div className={`material-surface ${styles.screen}`}>
      <PageHeader
        title="搜索"
        description="搜索公开资料、雷达，以及仅本人可见的研究草稿。"
      />

      <form onSubmit={handleSubmit} className={styles.form} role="search" aria-label="搜索平台内容">
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='例如 "RAG 评估" OR GraphRAG'
          aria-label="搜索关键词"
          sx={{ minWidth: 0, width: 'auto', flex: 1 }}
        />
        <Button type="submit" variant="contained" disabled={loading || !q.trim()}
          aria-label={loading ? '搜索中' : '搜索'} sx={{ flexShrink: 0 }}>
          <SearchIcon aria-hidden />
          <span className={styles.submitLabel}>{loading ? '搜索中…' : '搜索'}</span>
        </Button>
      </form>

      <Tabs aria-label="搜索结果类型" variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
        value={selectedType} selectionFollowsFocus
        onChange={(_event, v: string) => {
          replaceSearch({ type: v, page: 1 });
        }}
      >
        {TYPE_TABS.map(tab => <Tab key={tab.key} value={tab.key} label={tab.label}
          id={`search-type-${tab.key}`} aria-controls="search-results-panel" />)}
      </Tabs>

      <div id="search-results-panel" role="tabpanel" className={styles.results} tabIndex={0}
        aria-labelledby={selectedType ? `search-type-${selectedType}` : undefined}
        aria-label={selectedType ? undefined : '搜索结果'} aria-busy={loading}>
        {error ? (
          <ErrorState
            className={styles.error}
            title="搜索暂时失败"
            description={error}
            action={
              <Button type="button" size="small" variant="outlined" onClick={() => setRequestKey((value) => value + 1)}>
                重试
              </Button>
            }
          />
        ) : null}

        {!submittedQ && (
          <EmptyState title="开始搜索" description="输入关键词以搜索雷达、公开研究，以及本人草稿。" />
        )}

        {loading && (
          <div className={styles.list} role="status" aria-label="正在搜索">
            {[0, 1, 2].map((i) => (
              <Paper key={i} variant="outlined" className={styles.card}>
                <Skeleton variant="text" height={24} width="50%" />
                <Skeleton variant="text" height={20} />
              </Paper>
            ))}
          </div>
        )}

        {submittedQ && !loading && data && items.length === 0 && (
          <EmptyState title="没有匹配的内容" description="换个关键词，或切换到其他类型再试。" />
        )}

        {data && items.length > 0 && (
          <>
            <p className={styles.count} role="status">
              共 {data.total} 条结果
            </p>
            <ul className={styles.list}>
              {items.map((row) => {
                const typeLabel = TYPE_TABS.find(tab => tab.key === row.type)?.label ?? '摘要';
                return (
                  <li key={row.id} className={styles.item}>
                    <Paper component="article" variant="outlined" className={styles.card}>
                        <div className={styles.metadata}>
                          <Chip size="small" label={typeLabel} />
                          {row.isPrivate ? (
                            <span>本人草稿</span>
                          ) : null}
                        </div>
                        <h2 className={styles.title}>
                          <Link
                            href={detailHref(row)}
                          >
                            {row.title}
                          </Link>
                        </h2>
                        {/* highlighted snippet —— 后端用 <mark> 包裹全文匹配段，
                            并在返回前转义来源文本，只保留高亮标签。 */}
                        <p
                          className={styles.snippet}
                          dangerouslySetInnerHTML={{ __html: row.highlighted }}
                        />
                        <time className={styles.date} dateTime={row.publishedAt}>
                          {new Date(row.publishedAt).toLocaleString('zh-CN')}
                        </time>
                    </Paper>
                  </li>
                );
              })}
            </ul>

            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={(nextPage) => replaceSearch({ page: nextPage })}
              disabled={loading}
            />
          </>
        )}
      </div>
    </div>
  );
}
