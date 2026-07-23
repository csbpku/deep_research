'use client';

// /search — 全文搜索结果页。
//
// 行为：
//   - 顶部搜索框：保留 query string（刷新不丢）
//   - 按 type 分组 tab（全部 / 摘要 / 长文 / 精华）
//   - 每条结果：type 标签 + 标题（链接到详情）+ 高亮 snippet
//   - 未登录：服务端 redirect 到 signin（layout 级或本页 useEffect 触发）
//
// 设计：
//   - 客户端发起 GET /api/search?q=&type=&page=&per_page=
//   - 高亮来自后端 ts_headline（已用 <mark>...</mark> 包裹匹配段）
//   - 切 tab 时：把 ?type 写到 query string；前端不刷页面，只更新 state

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

interface SearchRow {
  id: string;
  type: 'summary' | 'long_research' | 'knowledge';
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

const TYPE_TABS: Array<{ key: '' | 'summary' | 'long_research' | 'knowledge'; label: string }> = [
  { key: '', label: '全部' },
  { key: 'summary', label: '摘要' },
  { key: 'long_research', label: '长文' },
  { key: 'knowledge', label: '精华' },
];

const TYPE_BADGE: Record<SearchRow['type'], { label: string; color: string; bg: string }> = {
  summary: { label: '摘要', color: '#0f766e', bg: '#ccfbf1' },
  long_research: { label: '长文', color: '#1d4ed8', bg: '#dbeafe' },
  knowledge: { label: '精华', color: '#7c2d12', bg: '#ffedd5' },
};

export default function SearchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialQ = searchParams.get('q') ?? '';
  const initialType = (searchParams.get('type') ?? '') as '' | SearchRow['type'];
  const initialPage = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);

  const [q, setQ] = useState(initialQ);
  const [submittedQ, setSubmittedQ] = useState(initialQ);
  const [type, setType] = useState<'' | SearchRow['type']>(initialType);
  const [page, setPage] = useState(initialPage);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detailHref = useCallback((row: SearchRow) => {
    if (row.type === 'summary') return `/summaries/${row.refId}`;
    return `/researches/${row.refId}`;
  }, []);

  // 同步 query string（不刷页面，仅 router.replace）
  useEffect(() => {
    const params = new URLSearchParams();
    if (submittedQ) params.set('q', submittedQ);
    if (type) params.set('type', type);
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
    if (type) params.set('type', type);
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
    <div>
      <h1 style={{ fontSize: 22, margin: '0 0 16px' }}>搜索</h1>

      {/* 搜索框 */}
      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索摘要 / 长文 / 精华..."
          style={{
            flex: 1,
            padding: '8px 12px',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            fontSize: 14,
            boxSizing: 'border-box',
          }}
        />
        <button
          type="submit"
          disabled={loading || !q.trim()}
          style={{
            padding: '8px 16px',
            border: 'none',
            borderRadius: 6,
            background: '#0f172a',
            color: '#fff',
            cursor: loading || !q.trim() ? 'default' : 'pointer',
            fontSize: 13,
            opacity: loading || !q.trim() ? 0.6 : 1,
          }}
        >
          {loading ? '搜索中...' : '搜索'}
        </button>
      </form>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #e2e8f0' }}>
        {TYPE_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => {
              setType(tab.key);
              setPage(1);
            }}
            style={{
              padding: '8px 14px',
              border: 'none',
              borderBottom: type === tab.key ? '2px solid #0f172a' : '2px solid transparent',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 13,
              color: type === tab.key ? '#0f172a' : '#64748b',
              fontWeight: type === tab.key ? 600 : 400,
              marginBottom: -1,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && (
        <div
          style={{
            border: '1px solid #fecaca',
            background: '#fef2f2',
            color: '#dc2626',
            padding: 12,
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}

      {!submittedQ && (
        <div style={{ color: '#94a3b8', textAlign: 'center', padding: 40 }}>
          输入关键词以搜索已发布的摘要、长文和精华
        </div>
      )}

      {submittedQ && !loading && data && items.length === 0 && (
        <div style={{ color: '#94a3b8', textAlign: 'center', padding: 40 }}>
          没有匹配的内容
        </div>
      )}

      {data && items.length > 0 && (
        <>
          <div style={{ fontSize: 13, color: '#64748b', marginBottom: 8 }}>
            共 {data.total} 条结果
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {items.map((row) => {
              const badge = TYPE_BADGE[row.type];
              return (
                <li
                  key={row.id}
                  style={{
                    border: '1px solid #e2e8f0',
                    borderRadius: 8,
                    padding: 14,
                    marginBottom: 8,
                    background: '#fff',
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 600,
                        background: badge.bg,
                        color: badge.color,
                      }}
                    >
                      {badge.label}
                    </span>
                    <Link
                      href={detailHref(row)}
                      style={{ fontSize: 15, color: '#0f172a', textDecoration: 'none', fontWeight: 500 }}
                    >
                      {row.title}
                    </Link>
                  </div>
                  {/* highlighted snippet —— 后端用 <mark> 包裹匹配段 */}
                  <p
                    style={{
                      fontSize: 13,
                      color: '#475569',
                      margin: '4px 0 0',
                      lineHeight: 1.6,
                    }}
                    // 后端 ts_headline 输出经 plainto_tsquery 生成的词条 + snippet 文本
                    // <mark> 是合法高亮标签，不引入 XSS（snippet 是 DB 来源）
                    dangerouslySetInnerHTML={{ __html: row.highlighted }}
                  />
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                    {new Date(row.publishedAt).toLocaleString('zh-CN')}
                  </div>
                </li>
              );
            })}
          </ul>

          {/* 分页 */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                style={paginationButtonStyle(page <= 1)}
              >
                上一页
              </button>
              <span style={{ fontSize: 13, color: '#475569', alignSelf: 'center' }}>
                第 {page} / {totalPages} 页
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                style={paginationButtonStyle(page >= totalPages)}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function paginationButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '6px 12px',
    border: '1px solid #e2e8f0',
    borderRadius: 4,
    background: '#fff',
    cursor: disabled ? 'default' : 'pointer',
    fontSize: 13,
    opacity: disabled ? 0.5 : 1,
  };
}