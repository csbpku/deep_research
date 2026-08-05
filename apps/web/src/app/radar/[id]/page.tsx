'use client';

import { useParams } from 'next/navigation';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ExternalLink, MessageSquare, Users, Workflow } from 'lucide-react';
import { EmptyState } from '../../../components/EmptyState';
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
import MarkdownContent from '../../../components/MarkdownContent';
import { Button } from '../../../components/ui/button';
import { toApiHttpError } from '../../../lib/errors/api-error';
import { retryOnceAi } from '../../../lib/errors/friendly';

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
  const [drawerTab, setDrawerTab] = useState<'team' | 'ai'>('ai');
  const me = useCurrentUser();
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
      <div className="mx-auto max-w-measure">
        <Link href="/radar" className="text-sm text-muted-foreground hover:text-primary">← 返回候选列表</Link>
        <p className="mt-4 text-sm text-muted-foreground">加载中…</p>
      </div>
    );
  }
  if (q.isError) {
    const errorMessage = String((q.error as Error).message);
    const needsLogin = errorMessage.includes('登录') || errorMessage.includes('授权');
    return (
      <div className="mx-auto max-w-measure">
        <Link href="/radar" className="text-sm text-muted-foreground hover:text-primary">← 返回候选列表</Link>
        <div className="mt-4">
          <EmptyState
            title={needsLogin ? '需要登录' : '加载失败'}
            description={needsLogin ? '登录后才能查看雷达详情、评分和讨论。' : errorMessage}
            action={needsLogin ? <Button asChild size="sm"><Link href="/signin">去登录</Link></Button> : undefined}
          />
        </div>
      </div>
    );
  }
  if (!q.data) return null;

  const d = q.data;
  const sourceLabel = formatSourceType(d.sourceType);

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/radar" className="text-sm text-muted-foreground hover:text-primary">← 返回候选列表</Link>

      <div className="mt-5 grid gap-8 lg:grid-cols-[minmax(0,760px)_240px] lg:items-start">
      <article className="min-w-0 space-y-4 leading-7">
        <header className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground"
            aria-label={sourceLabel.full}
            title={sourceLabel.full}
          >
            {sourceLabel.short}
          </span>
          {d.originalKind ? (
            <span
              data-testid="original-kind-badge"
              className="rounded-full border border-primary/30 bg-accent px-2 py-0.5 text-[11px] text-accent-foreground"
            >
              内容类型 {d.originalKind === 'arxiv' ? 'arXiv 论文' : d.originalKind}
            </span>
          ) : null}
          <span className="font-mono text-[11px] text-muted-foreground">
            抓取 {new Date(d.crawledAt).toISOString().slice(0, 10)}
          </span>
        </header>

        <h1 className="text-3xl font-semibold leading-tight tracking-tight">{d.title}</h1>

        {d.interpretation ? (
          <p
            className="rounded-md border-l-2 border-primary bg-accent/60 px-4 py-3 text-sm leading-7 text-foreground"
          >
            <span className="mr-1.5 text-xs font-medium text-muted-foreground">AI 一句话解读：</span>
            {d.interpretation}
          </p>
        ) : null}

        {d.distilledScore ? (
          <div className="my-3">
            <DistilledScorePanel score={d.distilledScore} />
          </div>
        ) : null}

        {!d.distilledScore && d.scoreReason ? (
          <p className="mb-3 text-sm text-muted-foreground">
            <strong>评分理由：</strong>
            {d.scoreReason}
          </p>
        ) : null}

        {d.selectionReason ? (
          <p
            className="my-2 rounded-md border-l-2 border-status-succeeded-fg bg-status-succeeded-bg px-3 py-2 text-sm text-status-succeeded-fg"
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
          <section className="my-8" aria-labelledby="radar-body-title">
            <h2 id="radar-body-title" className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">正文</h2>
            <MarkdownContent content={d.body} className="text-[15px] text-foreground" />
          </section>
        ) : null}

        {(() => {
          const displayTags = d.tags.filter((t) => {
            if (t === 'must_read' || t.startsWith('tier_') || t.startsWith('profile_') || t.startsWith('veto_') || t.startsWith('risk_')) return false;
            if (t === 'rss' || t === 'api' || t === 'web' || t === 'github' || t === 'tracked' || t === 'repo_digest') return false;
            return true;
          });
          if (displayTags.length === 0) return null;
          return (
            <div className="my-2 flex flex-wrap gap-1.5">
              {displayTags.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"
                >
                  #{t}
                </span>
              ))}
            </div>
          );
        })()}

        <div className="mt-6 flex flex-nowrap items-center gap-1 overflow-x-auto py-3">
          <RadarFeedbackBar
            summaryId={d.id}
            initialCounts={d.feedbackCounts}
            initialMine={d.myFeedbacks}
            types={['useful', 'inaccurate']}
            className="shrink-0 gap-1 py-0"
          />
          <Button asChild variant="outline" size="xs" className="ml-2 h-7 shrink-0 gap-1.5">
            <Link href={`/ai-research?seed=${d.id}`} aria-label="深入调研">
              <Workflow className="size-3.5" />
              深入调研
            </Link>
          </Button>
        </div>

        <AskAiDrawer
          summaryId={d.id}
          summaryTitle={d.title}
          summaryUrl={d.url}
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          initialTab={drawerTab}
          teamStatus={d.status}
          currentUserId={me.data?.id ?? null}
          currentUserRole={me.data?.role ?? null}
          contextExcerpt={d.originalMarkdown ?? d.body ?? d.highlights?.summary ?? d.interpretation ?? d.excerpt}
        />
      </article>

      <aside className="hidden space-y-3 lg:sticky lg:top-[72px] lg:block">
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">证据卡</h2>
          <dl className="grid gap-3 text-xs">
            <div><dt className="text-muted-foreground">来源</dt><dd className="mt-0.5 font-medium">{sourceLabel.full}</dd></div>
            <div><dt className="text-muted-foreground">抓取时间</dt><dd className="mt-0.5 font-mono text-[11px]">{new Date(d.crawledAt).toISOString().slice(0, 10)}</dd></div>
            <div><dt className="text-muted-foreground">阅读等级</dt><dd className="mt-0.5 font-medium">{d.distilledScore?.tier === 'deep_read' ? '深度阅读' : d.distilledScore?.tier === 'skim' ? '略读' : '待评估'}</dd></div>
            <div><dt className="text-muted-foreground">团队价值</dt><dd className="mt-0.5 font-mono text-sm text-status-succeeded-fg">{d.distilledScore?.rankingScore ?? d.distilledScore?.effectiveTotal ?? '—'}</dd></div>
          </dl>
        </section>
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">讨论</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">围绕当前证据继续团队协作，或让 AI 解释方法、风险和落地方式。</p>
          <Button type="button" variant="outline" size="sm" className="mt-3 w-full" onClick={() => { setDrawerTab('team'); setDrawerOpen(true); }}>
            <Users className="size-3.5" />
            打开讨论
          </Button>
          <Button type="button" variant="outline" size="sm" className="mt-2 w-full" onClick={() => { setDrawerTab('ai'); setDrawerOpen(true); }}>
            <MessageSquare className="size-3.5" />
            与 AI 讨论
          </Button>
          <a href={d.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border text-xs font-medium hover:bg-muted">
            <ExternalLink className="size-3.5" />
            打开原文
          </a>
        </section>
      </aside>
      </div>

    </div>
  );
}
