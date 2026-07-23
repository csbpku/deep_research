'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '../../components/EmptyState';

interface SummaryListItem {
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
}

interface SummariesResponse {
  date: string;
  count: number;
  items: SummaryListItem[];
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function shiftDate(yyyyMmDd: string, days: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map((s) => Number(s));
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return isoDate(t);
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export default function SummariesPage() {
  // 默认展示当天（与 BFF 兜底一致）。手动改 URL query 也走同一组件。
  const [date, setDate] = useState<string>(() => isoDate(new Date()));

  const q = useQuery<SummariesResponse>({
    queryKey: ['summaries', date],
    queryFn: async () => {
      const r = await fetch(`/api/summaries?date=${date}`, { cache: 'no-store' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '加载失败' }));
        throw new Error(err.message ?? '加载失败');
      }
      return (await r.json()) as SummariesResponse;
    },
  });

  const today = isoDate(new Date());
  const isToday = date === today;
  const items = q.data?.items ?? [];

  return (
    <div>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>每日摘要</h1>
      <p style={{ color: '#475569', marginTop: 0 }}>团队精选每天 4 条；点击卡片进入详情。</p>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          margin: '12px 0 16px',
        }}
      >
        <button
          type="button"
          onClick={() => setDate(shiftDate(date, -1))}
          style={dateBtnStyle}
          aria-label="前一天"
        >
          ← 前一天
        </button>
        <input
          type="date"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value)}
          style={{
            padding: '4px 8px',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
            fontSize: 14,
          }}
        />
        <button
          type="button"
          onClick={() => setDate(shiftDate(date, +1))}
          disabled={isToday}
          style={{ ...dateBtnStyle, opacity: isToday ? 0.5 : 1 }}
          aria-label="后一天"
        >
          后一天 →
        </button>
        <button
          type="button"
          onClick={() => setDate(today)}
          disabled={isToday}
          style={{ ...dateBtnStyle, opacity: isToday ? 0.5 : 1 }}
        >
          今天
        </button>
        <span style={{ marginLeft: 'auto', color: '#475569', fontSize: 13 }}>
          {q.isFetching ? '加载中…' : q.data ? `${q.data.count} 条` : ''}
        </span>
      </div>

      {q.isLoading ? (
        <p style={{ color: '#475569' }}>加载中…</p>
      ) : q.isError ? (
        <EmptyState title="加载失败" description={String((q.error as Error).message)} />
      ) : items.length === 0 ? (
        <EmptyState
          title="今日暂无精选摘要"
          description={`${date} 没有 published 状态的摘要（来源不足或尚未抓取）。`}
        />
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gap: 12,
          }}
        >
          {items.map((it) => (
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
                <h3 style={{ margin: '0 0 6px', fontSize: 16, color: '#0f172a' }}>{it.title}</h3>
                <p style={{ margin: '0 0 8px', color: '#334155', fontSize: 14, lineHeight: 1.55 }}>
                  {it.excerpt}
                </p>
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

const dateBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  border: '1px solid #cbd5e1',
  background: '#fff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
};
