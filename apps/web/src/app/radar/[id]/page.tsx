'use client';

import { useParams } from 'next/navigation';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '../../../components/EmptyState';
import { CommentSection } from '../../../components/CommentSection';
import { useCurrentUser } from '../../../lib/auth/client';
import { AskAiDrawer } from '../../../components/radar/AskAiDrawer';
import { RadarFeedbackBar } from '../../../components/radar/RadarFeedbackBar';
import type { RadarFeedbackCounts } from '../../../components/radar/RadarFeedbackBar';
import { RadarRepoStructureCard } from '../../../components/radar/RadarRepoStructureCard';
import { RadarArxivPaperCard } from '../../../components/radar/RadarArxivPaperCard';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';
import { DistilledScorePanel } from '../../../components/radar/DistilledScorePanel';

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
  distilledScore: DistilledScore | null;
  selectionReason: string | null;
  sortOrder: number | null;
  summaryDate: string;
  feedbackCounts: RadarFeedbackCounts;
  myFeedbacks: RadarFeedbackType[];
  canManage: boolean;
  // Phase 2A deep-dive: originalKind dispatches to a structured card;
  // originalMeta carries GitHub repo enrichment payload.
  originalKind: string | null;
  originalMarkdown: string | null;
  originalMeta: RepoMeta | null;
  // Phase 2B deep-dive: arxiv paper parsed structure.
  tldr: string | null;
  sections: Array<{ title: string; level: number; startOffset: number; page?: number }> | null;
  figures: Array<{ page: number; caption?: string; dataUrl?: string }> | null;
  authors: string[];
}

interface RepoMeta {
  provider?: string;
  defaultBranch?: string | null;
  language?: string | null;
  stars?: number | null;
  lastPushedAt?: string | null;
  description?: string | null;
  tree?: Array<{ path: string; type: 'blob' | 'tree' | 'commit'; size?: number; key?: boolean }>;
  entryPoints?: string[];
  fetchedAt?: string;
  trimmed?: boolean;
}

function parseOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : null;
}

export default function RadarDetailPage() {
  const params = useParams<{ id: string }>();
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
          {d.originalKind ? (
            <span
              data-testid="original-kind-badge"
              style={{
                padding: '2px 8px',
                border: '1px solid #7c3aed',
                borderRadius: 12,
                fontSize: 11,
                color: '#7c3aed',
                background: '#faf5ff',
              }}
            >
              {d.originalKind}
            </span>
          ) : null}
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            抓取 {new Date(d.crawledAt).toISOString().slice(0, 10)}
          </span>
          {d.scoreVersion ? (
            <span style={{ fontSize: 11, color: '#94a3b8' }}>评分版本 {d.scoreVersion}</span>
          ) : null}
        </header>

        <h1 style={{ fontSize: 24, marginTop: 12, marginBottom: 8 }}>{d.title}</h1>

        {d.originalKind === 'github_repo' && d.originalMeta && (() => {
          const parsed = parseOwnerRepo(d.url);
          if (!parsed) return null;
          return (
            <RadarRepoStructureCard
              meta={d.originalMeta}
              owner={parsed.owner}
              repo={parsed.repo}
            />
          );
        })()}

        {d.originalKind === 'arxiv' && (
          <RadarArxivPaperCard
            meta={(d.originalMeta as RepoMeta) ?? {}}
            title={d.title}
            authors={d.authors}
            tldr={d.tldr}
            sections={d.sections ?? []}
            figures={d.figures ?? []}
            markdown={d.originalMarkdown}
          />
        )}

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

        {d.distilledScore ? (
          <div style={{ margin: '12px 0' }}>
            <DistilledScorePanel score={d.distilledScore} />
          </div>
        ) : (
          <section
            aria-label="启发式预筛分"
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
        )}

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

        {d.body && d.body !== d.interpretation ? (
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

      {/* W9 code review 修订：Week 8 计划 §十 要求「在雷达、摘要和沉淀详情
          复用基础评论组件」，此前只接了摘要和沉淀两处，雷达这条腿一直缺。
          雷达候选本身就是 summaries 行（/api/radar/[id] 走 prisma.summary），
          所以 targetType 用 'summary' 即可，不需要动已冻结的 schema。

          只在 published 时渲染：/api/summaries/[id]/comments 对非 published
          目标一律返回 404（route.ts:57,132）。候选在 candidate /
          pending_review 态挂评论区，只会得到一个必然报错的空壳。 */}
      <RadarComments summaryId={d.id} status={d.status} />
    </div>
  );
}

function RadarComments({ summaryId, status }: { summaryId: string; status: string }) {
  const me = useCurrentUser();
  if (status !== 'published') {
    return (
      <p style={{ marginTop: 32, fontSize: 13, color: '#94a3b8' }}>
        该候选尚未选入每日摘要，选入发布后可在此讨论。
      </p>
    );
  }
  return (
    <CommentSection
      targetType="summary"
      targetId={summaryId}
      currentUserId={me.data?.id ?? null}
      currentUserRole={me.data?.role ?? null}
    />
  );
}
