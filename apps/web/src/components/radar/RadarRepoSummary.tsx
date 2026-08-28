import React from 'react';
import { Code2, GitBranch, Github, Star } from 'lucide-react';

interface RepoMeta {
  defaultBranch?: string | null;
  language?: string | null;
  stars?: number | null;
  forks?: number | null;
  openIssues?: number | null;
  lastPushedAt?: string | null;
  snapshotFetchedAt?: string | null;
}

function normalizeSummaryForComparison(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/\s+/gu, '')
    .replace(/[“”"'`。，！？：；,.!?():;—–-]/gu, '');
}

/** True when the long project explanation already contains the one-line brief. */
export function repoSummariesOverlap(brief: string, summary: string): boolean {
  const normalizedBrief = normalizeSummaryForComparison(brief);
  const normalizedSummary = normalizeSummaryForComparison(summary);
  if (!normalizedBrief || !normalizedSummary) return false;
  if (normalizedBrief === normalizedSummary) return true;
  const shorter = normalizedBrief.length <= normalizedSummary.length
    ? normalizedBrief
    : normalizedSummary;
  const longer = shorter === normalizedBrief ? normalizedSummary : normalizedBrief;
  return shorter.length >= 24 && longer.includes(shorter);
}

function formatStars(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export function RadarRepoSummary({
  brief,
  summary,
  meta,
}: {
  brief?: string | null;
  summary?: string | null;
  meta: RepoMeta | null;
}) {
  const briefText = brief?.trim() ?? '';
  const summaryText = summary?.trim() ?? '';
  const showBrief = Boolean(
    briefText && (!summaryText || !repoSummariesOverlap(briefText, summaryText)),
  );
  const paragraphs = summaryText
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (!showBrief && !summaryText) return null;

  return (
    <section className="my-5 rounded-lg bg-muted/30 px-4 py-4" aria-labelledby="repo-summary-title">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 id="repo-summary-title" className="flex items-center gap-1.5 text-sm font-semibold">
          <Github className="size-4 text-muted-foreground" aria-hidden />
          {summaryText ? '项目解读' : 'AI 一句话解读'}
        </h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
          {meta?.language ? (
            <span className="inline-flex items-center gap-1"><Code2 className="size-3" />{meta.language}</span>
          ) : null}
          {typeof meta?.stars === 'number' ? (
            <span className="inline-flex items-center gap-1"><Star className="size-3" />{formatStars(meta.stars)}</span>
          ) : null}
          {typeof meta?.forks === 'number' ? <span>Forks {formatStars(meta.forks)}</span> : null}
          {typeof meta?.openIssues === 'number' ? <span>Issues {meta.openIssues}</span> : null}
          {meta?.defaultBranch ? (
            <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{meta.defaultBranch}</span>
          ) : null}
          {meta?.lastPushedAt ? (
            <span>更新于 {new Date(meta.lastPushedAt).toLocaleDateString('zh-CN')}</span>
          ) : null}
          {meta?.snapshotFetchedAt ? (
            <span>快照 {new Date(meta.snapshotFetchedAt).toLocaleDateString('zh-CN')}</span>
          ) : null}
        </div>
      </div>
      {showBrief && summaryText ? (
        <div className="mb-4 rounded-md border-l-2 border-primary bg-background/70 px-3 py-2.5">
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">AI 一句话解读</p>
          <p className="text-sm leading-7 text-foreground/90">{briefText}</p>
        </div>
      ) : null}
      <div className="space-y-3 text-sm leading-7 text-foreground/90">
        {summaryText
          ? paragraphs.map((paragraph, index) => (
            <p key={`${index}-${paragraph.slice(0, 24)}`}>{paragraph}</p>
          ))
          : <p>{briefText}</p>}
      </div>
    </section>
  );
}
