'use client';

/**
 * ⚠️ Sentinel page —— inline style 保留（用户在 Week 9 review 时要求保留，
 * 作为"工艺快照"与其它页面的 design-token 化形成对照）。其余页面统一走
 * globals.css + tailwind。如需迁移，先开 P1 + 设计评审，避免静默删改。
 */

import { useParams } from 'next/navigation';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ExternalLink, MessageSquare } from 'lucide-react';
import { EmptyState } from '../../../components/EmptyState';
import { CommentSection } from '../../../components/CommentSection';
import { useCurrentUser } from '../../../lib/auth/client';
import { AskAiDrawer } from '../../../components/radar/AskAiDrawer';
import { RadarFeedbackBar } from '../../../components/radar/RadarFeedbackBar';
import type { RadarFeedbackCounts } from '../../../components/radar/RadarFeedbackBar';
import { RadarArxivPaperCard } from '../../../components/radar/RadarArxivPaperCard';
import { RadarRepoSummary } from '../../../components/radar/RadarRepoSummary';
import { RadarGithubItemSummary } from '../../../components/radar/RadarGithubItemSummary';
import { RadarArticleHighlights } from '../../../components/radar/RadarArticleHighlights';
import type { RadarGithubItemMeta } from '../../../lib/radar/shape';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';
import { formatSourceType } from '../../../lib/radar/source-labels';
import { DistilledScorePanel } from '../../../components/radar/DistilledScorePanel';
import { Button } from '../../../components/ui/button';
import { toApiHttpError } from '../../../lib/errors/api-error';
import { retryOnceAi } from '../../../lib/errors/friendly';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../../components/ui/tooltip';

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
  originalMeta: unknown;
  githubItemMeta: RadarGithubItemMeta | null;
  repoSummary: string | null;
  highlights: {
    summary: string;
    highlights: string[];
    keyQuote: string | null;
  } | null;
  arxivAnalysis: {
    tldr: string;
    motivation: string;
    method: string;
    result: string;
    conclusion: string;
  } | null;
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

export default function RadarDetailPage() {
  const params = useParams<{ id: string }>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const q = useQuery<RadarDetail>({
    queryKey: ['radar', params.id],
    queryFn: async () => {
      const r = await fetch(`/api/radar/${params.id}`, { cache: 'no-store' });
      if (!r.ok) {
        throw await toApiHttpError(r, '加载失败');
      }
      return (await r.json()) as RadarDetail;
    },
    retry: retryOnceAi,
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
  const sourceLabel = formatSourceType(d.sourceType);

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
            aria-label={sourceLabel.full}
            title={sourceLabel.full}
          >
            {sourceLabel.short}
          </span>
          {d.originalKind ? (
            <span
              data-testid="original-kind-badge"
              style={{
                padding: '2px 8px',
                border: '1px solid #bfdbfe',
                borderRadius: 12,
                fontSize: 11,
                color: '#1d4ed8',
                background: '#eff6ff',
              }}
            >
              内容类型 {d.originalKind === 'arxiv' ? 'arXiv 论文' : d.originalKind}
            </span>
          ) : null}
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            抓取 {new Date(d.crawledAt).toISOString().slice(0, 10)}
          </span>
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

        {d.distilledScore ? (
          <div style={{ margin: '12px 0' }}>
            <DistilledScorePanel score={d.distilledScore} />
          </div>
        ) : null}

        {!d.distilledScore && d.scoreReason ? (
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

        {d.originalKind === 'github_repo' && d.repoSummary ? (
          <RadarRepoSummary summary={d.repoSummary} meta={(d.originalMeta ?? null) as RepoMeta | null} />
        ) : null}

        {d.originalKind === 'arxiv' ? (
          <RadarArxivPaperCard
            meta={(d.originalMeta ?? {}) as { arxivId?: string; keyContributions?: string[]; sectionCount?: number }}
            authors={d.authors}
            tldr={d.tldr}
            analysis={d.arxivAnalysis}
          />
        ) : null}

        {(d.originalKind === 'github_other' || d.originalKind === 'github_release') && d.githubItemMeta ? (
          <RadarGithubItemSummary meta={d.githubItemMeta} />
        ) : null}

        {(d.originalKind === 'rss' || d.originalKind === 'web_share') && d.highlights ? (
          <RadarArticleHighlights {...d.highlights} />
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

        {(() => {
          const displayTags = d.tags.filter((t) => {
            if (t === 'must_read' || t.startsWith('tier_') || t.startsWith('profile_') || t.startsWith('veto_') || t.startsWith('risk_')) return false;
            if (t === 'rss' || t === 'api' || t === 'web' || t === 'github' || t === 'tracked' || t === 'repo_digest') return false;
            return true;
          });
          if (displayTags.length === 0) return null;
          return (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
              {displayTags.map((t) => (
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
          );
        })()}

        <div className="mt-4 flex flex-nowrap items-center gap-1 overflow-x-auto border-t border-border py-3">
          <RadarFeedbackBar
            summaryId={d.id}
            initialCounts={d.feedbackCounts}
            initialMine={d.myFeedbacks}
            className="shrink-0 gap-1 py-0"
          />
          <span className="h-5 w-px shrink-0 bg-border" aria-hidden />
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  variant="outline"
                  size="xs"
                  className="h-7 w-7 shrink-0 px-0"
                  aria-label="与 AI 讨论"
                >
                  <MessageSquare />
                </Button>
              </TooltipTrigger>
              <TooltipContent>与 AI 讨论</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild size="xs" className="h-7 w-7 shrink-0 px-0">
                  <a href={d.url} target="_blank" rel="noopener noreferrer" aria-label="打开原文">
                    <ExternalLink />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>打开原文</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

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
