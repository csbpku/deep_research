'use client';

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState } from '../../../components/EmptyState';
import { RadarCandidateCard } from '../../../components/radar/RadarCandidateCard';
import type { RadarFeedbackCounts } from '../../../components/radar/RadarFeedbackBar';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';

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
  distilledScore: DistilledScore | null;
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

const STATUS_OPTIONS = [
  { value: 'candidate', label: '候选' },
  { value: 'published', label: '已发布' },
  { value: 'rejected', label: '已忽略' },
  { value: 'archived', label: '已归档' },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function AdminRadarClient() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState('candidate');
  const [sourceType, setSourceType] = useState('');
  const [page, setPage] = useState(1);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [selectOpenFor, setSelectOpenFor] = useState<string | null>(null);
  const [selectDate, setSelectDate] = useState<string>(todayIso());
  const [selectOrder, setSelectOrder] = useState<number>(1);
  const [selectReason, setSelectReason] = useState<string>('');

  const query = useQuery<RadarListResponse>({
    queryKey: ['adminRadar', status, sourceType, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('status', status);
      if (sourceType) params.set('sourceType', sourceType);
      params.set('page', String(page));
      params.set('per_page', '20');
      const r = await fetch(`/api/admin/radar?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '加载失败' }));
        throw new Error(err.message ?? '加载失败');
      }
      return (await r.json()) as RadarListResponse;
    },
    placeholderData: (prev) => prev,
  });

  const selectMutation = useMutation({
    mutationFn: async (input: { id: string; summaryDate: string; sortOrder: number; selectionReason: string }) => {
      const r = await fetch(`/api/admin/radar/${input.id}/select`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          summaryDate: input.summaryDate,
          sortOrder: input.sortOrder,
          selectionReason: input.selectionReason,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? '选入失败');
      }
      return r.json();
    },
    onSuccess: () => {
      setActionErr(null);
      setSelectOpenFor(null);
      void queryClient.invalidateQueries({ queryKey: ['adminRadar'] });
    },
    onError: (e) => {
      setActionErr(e instanceof Error ? e.message : '选入失败');
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/radar/${id}/dismiss`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? '忽略失败');
      }
      return r.json();
    },
    onSuccess: () => {
      setActionErr(null);
      void queryClient.invalidateQueries({ queryKey: ['adminRadar'] });
    },
    onError: (e) => {
      setActionErr(e instanceof Error ? e.message : '忽略失败');
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/radar/${id}/retry-interpretation`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? '重试失败');
      }
      return r.json();
    },
    onSuccess: () => {
      setActionErr(null);
      void queryClient.invalidateQueries({ queryKey: ['adminRadar'] });
    },
    onError: (e) => {
      setActionErr(e instanceof Error ? e.message : '重试失败');
    },
  });

  const createResearchMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/radar/${id}/create-research`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? '创建调研失败');
      }
      return r.json();
    },
    onSuccess: (data) => {
      setActionErr(null);
      const researchId = (data as { research?: { id?: string } }).research?.id;
      if (researchId) router.push(`/researches/${researchId}/edit`);
    },
    onError: (e) => {
      setActionErr(e instanceof Error ? e.message : '创建调研失败');
    },
  });

  const items = query.data?.items ?? [];
  const totalPages = query.data?.totalPages ?? 1;

  return (
    <div>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>Admin · 雷达队列</h1>
      <p style={{ color: '#475569', marginTop: 0 }}>
        候选状态切换：选入摘要 / 创建 AI 调研 / 忽略 / 重试解读。所有操作会写入 admin_actions 审计。
      </p>

      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'center',
          padding: 12,
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          background: '#fff',
          margin: '12px 0 16px',
        }}
      >
        <label style={{ fontSize: 13, color: '#475569' }}>
          状态
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            style={{ marginLeft: 6, padding: '4px 8px', border: '1px solid #cbd5e1', borderRadius: 4 }}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13, color: '#475569' }}>
          来源
          <select
            value={sourceType}
            onChange={(e) => { setSourceType(e.target.value); setPage(1); }}
            style={{ marginLeft: 6, padding: '4px 8px', border: '1px solid #cbd5e1', borderRadius: 4 }}
          >
            <option value="">全部</option>
            <option value="github">GitHub</option>
            <option value="arxiv">arXiv</option>
            <option value="rss">RSS</option>
          </select>
        </label>
        <span style={{ marginLeft: 'auto', color: '#64748b', fontSize: 13 }}>
          {query.isFetching ? '加载中…' : query.data ? `共 ${query.data.total} 条` : ''}
        </span>
      </div>

      {actionErr ? (
        <div role="alert" style={{ padding: 8, background: '#fee2e2', color: '#991b1b', borderRadius: 4, marginBottom: 8 }}>
          {actionErr}
        </div>
      ) : null}

      {query.isLoading ? (
        <p style={{ color: '#475569' }}>加载中…</p>
      ) : query.isError ? (
        <EmptyState title="加载失败" description={String((query.error as Error).message)} />
      ) : items.length === 0 ? (
        <EmptyState title="队列为空" description={`当前状态 ${status} 下没有候选。`} />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {items.map((it) => (
            <RadarCandidateCard
              key={it.id}
              candidate={it}
              adminActions={
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {it.status === 'candidate' ? (
                    <button
                      type="button"
                      onClick={() => {
                        setActionErr(null);
                        setSelectOpenFor(it.id);
                        setSelectDate(todayIso());
                        setSelectOrder(it.sortOrder ?? 1);
                        setSelectReason('');
                      }}
                      style={btnPrimary}
                    >
                      选入摘要
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => createResearchMutation.mutate(it.id)}
                    disabled={createResearchMutation.isPending}
                    style={btnSecondary}
                  >
                    创建 AI 调研
                  </button>
                  {it.status === 'candidate' ? (
                    <button
                      type="button"
                      onClick={() => dismissMutation.mutate(it.id)}
                      disabled={dismissMutation.isPending}
                      style={btnDanger}
                    >
                      忽略
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => retryMutation.mutate(it.id)}
                    disabled={retryMutation.isPending}
                    style={btnSecondary}
                  >
                    重试解读
                  </button>
                </div>
              }
            />
          ))}
        </div>
      )}

      {selectOpenFor ? (
        <div
          role="dialog"
          aria-label="选入摘要"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <div
            style={{
              background: '#fff',
              padding: 24,
              borderRadius: 8,
              width: 480,
              maxWidth: '90%',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 18 }}>选入每日摘要</h2>
            <label style={{ fontSize: 13, color: '#475569' }}>
              发布日期
              <input
                type="date"
                value={selectDate}
                onChange={(e) => setSelectDate(e.target.value)}
                style={{ marginLeft: 8, padding: '4px 8px', border: '1px solid #cbd5e1', borderRadius: 4 }}
              />
            </label>
            <label style={{ fontSize: 13, color: '#475569' }}>
              排序（1-4）
              <input
                type="number"
                min={1}
                max={4}
                value={selectOrder}
                onChange={(e) => setSelectOrder(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
                style={{ marginLeft: 8, padding: '4px 8px', border: '1px solid #cbd5e1', borderRadius: 4, width: 80 }}
              />
            </label>
            <label style={{ fontSize: 13, color: '#475569', display: 'block' }}>
              入选理由
              <textarea
                value={selectReason}
                onChange={(e) => setSelectReason(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="例如：本周 GitHub 趋势项目；与团队正在评估的 RAG 方案相关…"
                style={{
                  marginTop: 6,
                  width: '100%',
                  padding: '6px 8px',
                  border: '1px solid #cbd5e1',
                  borderRadius: 4,
                  fontSize: 13,
                  boxSizing: 'border-box',
                }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setSelectOpenFor(null)}
                style={btnSecondary}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!selectOpenFor) return;
                  selectMutation.mutate({
                    id: selectOpenFor,
                    summaryDate: selectDate,
                    sortOrder: selectOrder,
                    selectionReason: selectReason.trim(),
                  });
                }}
                disabled={selectMutation.isPending || selectReason.trim().length < 2}
                style={btnPrimary}
              >
                {selectMutation.isPending ? '提交中…' : '确认'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {totalPages > 1 ? (
        <nav style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', margin: '16px 0' }}>
          <button
            type="button"
            disabled={page <= 1 || query.isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            style={btnSecondary}
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
            style={btnSecondary}
          >
            下一页 →
          </button>
        </nav>
      ) : null}
    </div>
  );
}

const btnPrimary: React.CSSProperties = {
  padding: '6px 14px',
  border: '1px solid #0f172a',
  background: '#0f172a',
  color: '#fff',
  borderRadius: 4,
  fontSize: 13,
  cursor: 'pointer',
};
const btnSecondary: React.CSSProperties = {
  padding: '6px 12px',
  border: '1px solid #cbd5e1',
  background: '#fff',
  color: '#334155',
  borderRadius: 4,
  fontSize: 13,
  cursor: 'pointer',
};
const btnDanger: React.CSSProperties = {
  padding: '6px 12px',
  border: '1px solid #b91c1c',
  background: '#fff',
  color: '#b91c1c',
  borderRadius: 4,
  fontSize: 13,
  cursor: 'pointer',
};