'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '../../../components/EmptyState';
import { AskAiDrawer } from '../../../components/radar/AskAiDrawer';
import { RadarFeedbackBar } from '../../../components/radar/RadarFeedbackBar';
import type { RadarFeedbackCounts } from '../../../components/radar/RadarFeedbackBar';
import type { RadarFeedbackType } from '@deep-research/shared/states';

interface RadarDetail {
  id: string;
  title: string;
  excerpt: string;
  body: string | null;
  url: string;
  sourceType: string | null;
  tags: string[];
  status: string;
  publishedAt: string | null;
  crawledAt: string;
  interpretation: string | null;
  scoreReason: string | null;
  scoreVersion: string | null;
  relevanceScore: number | null;
  timelinessScore: number | null;
  sourceQualityScore: number | null;
  selectionReason: string | null;
  sortOrder: number | null;
  summaryDate: string;
  feedbackCounts: RadarFeedbackCounts;
  myFeedbacks: RadarFeedbackType[];
  canManage: boolean;
}

export default function RadarDetailPage({ params }: { params: { id: string } }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const q = useQuery<RadarDetail>({
    queryKey: ['radar', params.id],
    queryFn: async () => {
      const r = await fetch(`/api/radar/${params.id}`, { cache: 'no-store' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '加载失败' }));
        throw new Error(err.message ?? '加载失败');
      }
      return (await r.json()) as RadarDetail;
    },
  });

  if (q.isLoading) {
    return (
      <div>
        <Link href="/radar" style={{ fontSize: 13, color: '#475569' }}>← 返回候选列表</Link>
        <p style={{ color: '#475569', marginTop: 16 }}>加载中…</p>
      </div>
    );
  }
  if (q.isError) {
    return (
      <div>
        <Link href="/radar" style={{ fontSize: 13, color: '#475569' }}>← 返回候选列表</Link>
        <div style={{ marginTop: 16 }}>
          <EmptyState title="加载失败" description={String((q.error as Error).message)} />
        </div>
      </div>
    );
  }
  if (!q.data) return null;

  const d = q.data;

  return (
    <div>
      <Link href="/radar" style={{ fontSize: 13, color: '#475569' }}>← 返回候选列表</Link>

      <article style={{ marginTop: 16, lineHeight: 1.65 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            style={{
              padding: '2px 8px',
              border: '1px solid #cbd5e1',
              borderRadius: 12,
              fontSize: 11,
              color: '#475569',
              background: '#fff',
            }}
          >
            来源 {d.sourceType ?? 'unknown'}
          </span>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            抓取 {new Date(d.crawledAt).toISOString().slice(0, 10)}
          </span>
          {d.scoreVersion ? (
            <span style={{ fontSize: 11, color: '#94a3b8' }}>评分版本 {d.scoreVersion}</span>
          ) : null}
        </header>

        <h1 style={{ fontSize: 24, marginTop: 12, marginBottom: 8 }}>{d.title}</h1>

        {d.interpretation ? (
          <p
            style={{
              padding: '12px 16px',
              background: '#f8fafc',
              borderRadius: 6,
              borderLeft: '3px solid #0f172a',
              color: '#1e293b',
              fontSize: 15,
              margin: '8px 0 16px',
            }}
          >
            <span style={{ color: '#64748b', fontSize: 12, marginRight: 6 }}>AI 一句话解读：</span>
            {d.interpretation}
          </p>
        ) : null}

        <section
          aria-label="三维评分"
          style={{ display: 'flex', gap: 8, margin: '12px 0', flexWrap: 'wrap' }}
        >
          {(['relevanceScore', 'timelinessScore', 'sourceQualityScore'] as const).map((k) => {
            const v = d[k];
            const labels: Record<string, string> = {
              relevanceScore: '相关性',
              timelinessScore: '时效',
              sourceQualityScore: '来源质量',
            };
            if (v === null) return null;
            return (
              <span
                key={k}
                style={{
                  padding: '4px 10px',
                  background: '#f1f5f9',
                  borderRadius: 14,
                  fontSize: 13,
                  color: '#334155',
                }}
              >
                <strong>{labels[k]}</strong> {v.toFixed(2)}
              </span>
            );
          })}
        </section>

        {d.scoreReason ? (
          <p style={{ fontSize: 13, color: '#475569', margin: '4px 0 12px' }}>
            <strong>评分理由：</strong>
            {d.scoreReason}
          </p>
        ) : null}

        {d.selectionReason ? (
          <p
            style={{
              fontSize: 13,
              color: '#166534',
              background: '#f0fdf4',
              padding: '8px 12px',
              borderRadius: 6,
              borderLeft: '3px solid #22c55e',
              margin: '8px 0',
            }}
          >
            <strong>入选理由：</strong>
            {d.selectionReason}
            {d.sortOrder !== null ? `（#${d.sortOrder}）` : ''}
          </p>
        ) : null}

        {d.body ? (
          <div
            style={{
              whiteSpace: 'pre-wrap',
              color: '#1e293b',
              fontSize: 15,
              margin: '12px 0 24px',
              padding: 16,
              background: '#fff',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
            }}
          >
            {d.body}
          </div>
        ) : null}

        {d.tags.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
            {d.tags.map((t) => (
              <span
                key={t}
                style={{
                  padding: '2px 10px',
                  background: '#f1f5f9',
                  color: '#475569',
                  borderRadius: 12,
                  fontSize: 12,
                }}
              >
                #{t}
              </span>
            ))}
          </div>
        ) : null}

        <RadarFeedbackBar
          summaryId={d.id}
          initialCounts={d.feedbackCounts}
          initialMine={d.myFeedbacks}
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <Link
            href={`/ai-research?seed=${encodeURIComponent(d.id)}`}
            style={{
              padding: '6px 12px',
              border: '1px solid #7c3aed',
              borderRadius: 4,
              background: '#7c3aed',
              color: '#fff',
              textDecoration: 'none',
              fontSize: 13,
            }}
          >
            ✨ 建议深入调研
          </Link>
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            style={{
              padding: '6px 12px',
              border: '1px solid #cbd5e1',
              borderRadius: 4,
              background: '#fff',
              color: '#334155',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            💬 与 AI 讨论
          </button>
        </div>

        <a
          href={d.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-block',
            padding: '8px 14px',
            border: '1px solid #0f172a',
            background: '#0f172a',
            color: '#fff',
            borderRadius: 4,
            textDecoration: 'none',
            fontSize: 14,
            marginTop: 8,
          }}
        >
          打开原文 ↗
        </a>

        {d.canManage ? (
          <div
            style={{
              marginTop: 16,
              padding: 12,
              background: '#f8fafc',
              border: '1px dashed #cbd5e1',
              borderRadius: 6,
              color: '#475569',
              fontSize: 13,
            }}
          >
            Admin：前往 <Link href={`/admin/radar?focus=${d.id}`} style={{ color: '#0f172a' }}>/admin/radar</Link> 管理此候选。
          </div>
        ) : null}

        <AskAiDrawer
          summaryId={d.id}
          summaryTitle={d.title}
          summaryUrl={d.url}
          summaryInterpretation={d.interpretation}
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
        />
      </article>
    </div>
  );
}
