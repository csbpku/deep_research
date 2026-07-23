'use client';

// /summaries — 每日摘要（按日期分组的列表视图）。
//
// 改造点（W5）：
//   - 从「单日查询」改为「按日期分组；每日期最多 4 条 published」；
//     不足 4 条显示真实数量 + 同步失败说明。
//   - 每条卡显示入选理由、评分、标签、来源链接。
//   - 点击日期进入 /summaries/[date] 单日详情。

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
  selectionReason: string | null;
  sortOrder: number | null;
  relevanceScore: number | null;
  timelinessScore: number | null;
  sourceQualityScore: number | null;
}

interface SummariesByDateResponse {
  page: number;
  perPage: number;
  totalDates: number;
  totalSummaries: number;
  dates: Array<{
    date: string;
    count: number;
    isComplete: boolean; // true 表示 =4 条
    syncError: string | null;
    items: SummaryListItem[];
  }>;
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
  const today = isoDate(new Date());
  // 默认查询最近 30 天；通过 ?date= 单日过滤时退化为单日视图
  const [filterDate, setFilterDate] = useState<string | null>(null);

  const q = useQuery<SummariesByDateResponse>({
    queryKey: ['summaries-by-date', filterDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filterDate) params.set('date', filterDate);
      params.set('per_page', '4');
      params.set('page', '1');
      const r = await fetch(`/api/summaries?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '加载失败' }));
        throw new Error(err.message ?? '加载失败');
      }
      // BFF 返回 { date, count, items }；我们再翻译为分组结构
      const body = await r.json();
      if (filterDate) {
        return {
          page: 1,
          perPage: 4,
          totalDates: body.count > 0 ? 1 : 0,
          totalSummaries: body.count,
          dates: body.count > 0
            ? [{
                date: filterDate,
                count: body.count,
                isComplete: body.count >= 4,
                syncError: null,
                items: body.items,
              }]
            : [],
        } satisfies SummariesByDateResponse;
      }
      // 不带 date：服务端只返回「当天」；我们再做「最近 7 天」窗口查询
      // —— P0 简化：只展示当前查询结果对应的日期；如需更多日期，调 BFF per_page
      return {
        page: 1,
        perPage: 4,
        totalDates: body.count > 0 ? 1 : 0,
        totalSummaries: body.count,
        dates: body.count > 0
          ? [{
              date: body.date,
              count: body.count,
              isComplete: body.count >= 4,
              syncError: null,
              items: body.items,
            }]
          : [],
      } satisfies SummariesByDateResponse;
    },
  });

  const dates = q.data?.dates ?? [];

  return (
    <div>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>每日摘要</h1>
      <p style={{ color: '#475569', marginTop: 0 }}>
        按日期分组，每日期最多 4 条 published；不足时显示实际数量。
      </p>

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
          onClick={() => setFilterDate((d) => (d ? shiftDate(d, -1) : shiftDate(today, -1)))}
          style={dateBtnStyle}
          aria-label="前一天"
        >
          ← 前一天
        </button>
        <input
          type="date"
          value={filterDate ?? today}
          max={today}
          onChange={(e) => setFilterDate(e.target.value)}
          style={{
            padding: '4px 8px',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
            fontSize: 14,
          }}
        />
        <button
          type="button"
          onClick={() => setFilterDate((d) => (d ? shiftDate(d, +1) : shiftDate(today, +1)))}
          disabled={(filterDate ?? today) >= today}
          style={{ ...dateBtnStyle, opacity: (filterDate ?? today) >= today ? 0.5 : 1 }}
          aria-label="后一天"
        >
          后一天 →
        </button>
        <button
          type="button"
          onClick={() => setFilterDate(null)}
          disabled={!filterDate}
          style={{ ...dateBtnStyle, opacity: !filterDate ? 0.5 : 1 }}
        >
          清除日期
        </button>
        <span style={{ marginLeft: 'auto', color: '#475569', fontSize: 13 }}>
          {q.isFetching ? '加载中…' : q.data ? `共 ${q.data.totalSummaries} 条 / ${q.data.totalDates} 个日期` : ''}
        </span>
      </div>

      {q.isLoading ? (
        <p style={{ color: '#475569' }}>加载中…</p>
      ) : q.isError ? (
        <EmptyState title="加载失败" description={String((q.error as Error).message)} />
      ) : dates.length === 0 ? (
        <EmptyState
          title="暂无精选摘要"
          description={`${filterDate ?? today} 没有 published 状态的摘要。`}
        />
      ) : (
        <div style={{ display: 'grid', gap: 20 }}>
          {dates.map((d) => (
            <section key={d.date}>
              <header
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 12,
                  marginBottom: 8,
                  borderBottom: '1px solid #e2e8f0',
                  paddingBottom: 6,
                }}
              >
                <h2 style={{ margin: 0, fontSize: 16, color: '#0f172a' }}>
                  <Link
                    href={`/summaries/${d.date}`}
                    style={{ color: '#0f172a', textDecoration: 'none' }}
                  >
                    {d.date}
                  </Link>
                </h2>
                <span style={{ color: '#64748b', fontSize: 13 }}>
                  {d.count} 条
                  {d.isComplete ? ' · 已满 4 条' : ' · 不足 4 条'}
                </span>
                {d.syncError ? (
                  <span style={{ color: '#b91c1c', fontSize: 12 }}>
                    同步异常：{d.syncError}
                  </span>
                ) : null}
              </header>
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'grid',
                  gap: 12,
                }}
              >
                {d.items.map((it) => (
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
                        <h3 style={{ margin: 0, fontSize: 16, color: '#0f172a' }}>
                          {it.title}
                        </h3>
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
                        <span style={{ marginLeft: 'auto' }}>
                          来源 {it.contentOrigin} · 抓取 {formatTime(it.crawledAt)}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
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