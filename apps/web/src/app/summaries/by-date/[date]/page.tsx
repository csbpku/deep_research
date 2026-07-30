'use client';

import { useParams } from 'next/navigation';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { EmptyState } from '../../../../components/EmptyState';

interface SummaryItem {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  tags: string[];
  contentOrigin: string;
  summaryDate: string;
  publishedAt: string | null;
  crawledAt: string;
  source: string;
  sortOrder: number | null;
  selectionReason: string | null;
  relevanceScore: number | null;
  timelinessScore: number | null;
  sourceQualityScore: number | null;
}

interface SummariesResponse {
  date: string;
  count: number;
  items: SummaryItem[];
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export default function SummariesByDatePage() {
  const params = useParams<{ date: string }>();
  // YYYY-MM-DD 校验；前端轻校验，错误走 EmptyState
  const dateOk = /^\d{4}-\d{2}-\d{2}$/u.test(params.date);

  const q = useQuery<SummariesResponse>({
    queryKey: ['summaries-date', params.date],
    queryFn: async () => {
      const r = await fetch(`/api/summaries?date=${params.date}`, { cache: 'no-store' });
      if (!r.ok) {
        if (r.status === 404) {
          throw new Error('该日期未发布摘要');
        }
        const err = await r.json().catch(() => ({ message: '加载失败' }));
        throw new Error(err.message ?? '加载失败');
      }
      return (await r.json()) as SummariesResponse;
    },
    enabled: dateOk,
  });

  if (!dateOk) {
    return (
      <div>
        <Link href="/summaries" style={{ fontSize: 13, color: '#475569' }}>← 返回摘要列表</Link>
        <div style={{ marginTop: 16 }}>
          <EmptyState title="日期格式错误" description="期望 YYYY-MM-DD" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <Link href="/summaries" style={{ fontSize: 13, color: '#475569' }}>← 返回摘要列表</Link>

      <header style={{ marginTop: 16, marginBottom: 12 }}>
        <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>{params.date} · 每日摘要</h1>
        {q.data ? (
          <p style={{ color: '#475569', marginTop: 0 }}>
            {q.data.count} 条
            {q.data.count >= 4 ? ' · 已满 4 条' : ' · 不足 4 条'}
          </p>
        ) : null}
      </header>

      {q.isLoading ? (
        <p style={{ color: '#475569' }}>加载中…</p>
      ) : q.isError ? (
        <EmptyState title="加载失败" description={String((q.error as Error).message)} />
      ) : !q.data || q.data.count === 0 ? (
        <EmptyState
          title="该日期未发布摘要"
          description={`${params.date} 没有 published 状态的摘要。可能是尚未抓取或管理员未选入。`}
        />
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
          {q.data.items.map((it) => (
            <li key={it.id}>
              <Link
                href={`/summaries/${it.id}`}
                style={{
                  display: 'block',
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  background: '#fff',
                  padding: 16,
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  {it.sortOrder !== null ? (
                    <span
                      style={{
                        display: 'inline-block',
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        background: '#0f172a',
                        color: '#fff',
                        fontSize: 12,
                        textAlign: 'center',
                        lineHeight: '22px',
                      }}
                    >
                      {it.sortOrder}
                    </span>
                  ) : null}
                  <h2 style={{ margin: 0, fontSize: 17, color: '#0f172a' }}>{it.title}</h2>
                </div>
                <p style={{ margin: '6px 0 8px', color: '#334155', fontSize: 14, lineHeight: 1.55 }}>
                  {it.excerpt}
                </p>
                {it.selectionReason ? (
                  <p
                    style={{
                      margin: '0 0 8px',
                      padding: '6px 10px',
                      background: '#f0fdf4',
                      borderLeft: '3px solid #22c55e',
                      color: '#166534',
                      fontSize: 13,
                    }}
                  >
                    <strong>入选理由：</strong>{it.selectionReason}
                  </p>
                ) : null}
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    alignItems: 'center',
                    fontSize: 12,
                    color: '#64748b',
                  }}
                >
                  {it.tags.map((t) => (
                    <span
                      key={t}
                      style={{
                        padding: '2px 8px',
                        borderRadius: 12,
                        background: '#f1f5f9',
                        color: '#334155',
                      }}
                    >
                      #{t}
                    </span>
                  ))}
                  {it.relevanceScore !== null ? (
                    <span style={{ padding: '2px 8px', background: '#eef2ff', color: '#3730a3', borderRadius: 12 }}>
                      相关性 {it.relevanceScore.toFixed(2)}
                    </span>
                  ) : null}
                  <span style={{ marginLeft: 'auto' }}>
                    来源 {it.contentOrigin} · 抓取 {formatTime(it.crawledAt)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}