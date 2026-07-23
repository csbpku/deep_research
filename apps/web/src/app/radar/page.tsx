'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { RadarCandidateCard } from '../../components/radar/RadarCandidateCard';
import type { RadarFeedbackCounts } from '../../components/radar/RadarFeedbackBar';
import type { RadarFeedbackType } from '@deep-research/shared/states';

interface RadarCandidateListItem {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  sourceType: string | null;
  tags: string[];
  status: string;
  publishedAt: string | null;
  crawledAt: string;
  interpretation: string | null;
  scoreReason: string | null;
  relevanceScore: number | null;
  timelinessScore: number | null;
  sourceQualityScore: number | null;
  selectionReason: string | null;
  sortOrder: number | null;
  feedbackCounts: RadarFeedbackCounts;
  myFeedbacks: RadarFeedbackType[];
}

interface RadarListResponse {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  items: RadarCandidateListItem[];
}

const SOURCE_TYPE_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'github', label: 'GitHub' },
  { value: 'arxiv', label: 'arXiv' },
  { value: 'rss', label: 'RSS' },
];

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'candidate', label: '候选' },
  { value: 'published', label: '已发布' },
  { value: 'rejected', label: '已忽略' },
];

export default function RadarPage() {
  const [q, setQ] = useState('');
  const [sourceType, setSourceType] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const query = useQuery<RadarListResponse>({
    queryKey: ['radar', q, sourceType, status, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (sourceType) params.set('sourceType', sourceType);
      if (status) params.set('status', status);
      params.set('page', String(page));
      params.set('per_page', '20');
      const r = await fetch(`/api/radar?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '加载失败' }));
        throw new Error(err.message ?? '加载失败');
      }
      return (await r.json()) as RadarListResponse;
    },
    placeholderData: (prev) => prev,
  });

  const items = query.data?.items ?? [];
  const totalPages = query.data?.totalPages ?? 1;

  return (
    <div>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>技术雷达</h1>
      <p style={{ color: '#475569', marginTop: 0 }}>
        来自 GitHub / arXiv / RSS 的候选；AI 一句话解读 + 三维评分；点击标题进入详情。
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          void query.refetch();
        }}
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'center',
          margin: '12px 0 16px',
          padding: 12,
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          background: '#fff',
        }}
      >
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索标题 / 解读 / 标签…"
          style={{
            padding: '6px 10px',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
            fontSize: 14,
            minWidth: 220,
          }}
        />
        <select
          value={sourceType}
          onChange={(e) => { setSourceType(e.target.value); setPage(1); }}
          style={{ padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 4, fontSize: 14 }}
        >
          {SOURCE_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          style={{ padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 4, fontSize: 14 }}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <button
          type="submit"
          style={{
            padding: '6px 16px',
            border: '1px solid #0f172a',
            background: '#0f172a',
            color: '#fff',
            borderRadius: 4,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          搜索
        </button>
        <span style={{ marginLeft: 'auto', color: '#64748b', fontSize: 13 }}>
          {query.isFetching ? '加载中…' : query.data ? `共 ${query.data.total} 条` : ''}
        </span>
      </form>

      {query.isLoading ? (
        <p style={{ color: '#475569' }}>加载中…</p>
      ) : query.isError ? (
        <EmptyState title="加载失败" description={String((query.error as Error).message)} />
      ) : items.length === 0 ? (
        <EmptyState
          title="暂无候选"
          description="雷达同步尚未产出候选；稍后再来或联系 admin 触发手动同步。"
        />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {items.map((it) => (
            <RadarCandidateCard key={it.id} candidate={it} />
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <nav
          aria-label="分页"
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 8,
            margin: '16px 0',
          }}
        >
          <button
            type="button"
            disabled={page <= 1 || query.isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            style={paginationBtn}
          >
            ← 上一页
          </button>
          <span style={{ fontSize: 13, color: '#475569' }}>
            第 {page} / {totalPages} 页
          </span>
          <button
            type="button"
            disabled={page >= totalPages || query.isFetching}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            style={paginationBtn}
          >
            下一页 →
          </button>
        </nav>
      ) : null}
    </div>
  );
}

const paginationBtn: React.CSSProperties = {
  padding: '4px 12px',
  border: '1px solid #cbd5e1',
  background: '#fff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
};