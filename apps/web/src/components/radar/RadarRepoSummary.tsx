import { Code2, GitBranch, Github, Star } from 'lucide-react';

interface RepoMeta {
  defaultBranch?: string | null;
  language?: string | null;
  stars?: number | null;
  lastPushedAt?: string | null;
}

function formatStars(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export function RadarRepoSummary({ summary, meta }: { summary: string; meta: RepoMeta | null }) {
  const paragraphs = summary
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return (
    <section className="my-5 rounded-lg bg-muted/30 px-4 py-4" aria-labelledby="repo-summary-title">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 id="repo-summary-title" className="flex items-center gap-1.5 text-sm font-semibold">
          <Github className="size-4 text-muted-foreground" aria-hidden />
          项目解读
        </h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
          {meta?.language ? (
            <span className="inline-flex items-center gap-1"><Code2 className="size-3" />{meta.language}</span>
          ) : null}
          {typeof meta?.stars === 'number' ? (
            <span className="inline-flex items-center gap-1"><Star className="size-3" />{formatStars(meta.stars)}</span>
          ) : null}
          {meta?.defaultBranch ? (
            <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{meta.defaultBranch}</span>
          ) : null}
          {meta?.lastPushedAt ? (
            <span>更新于 {new Date(meta.lastPushedAt).toLocaleDateString('zh-CN')}</span>
          ) : null}
        </div>
      </div>
      <div className="space-y-3 text-sm leading-7 text-foreground/90">
        {paragraphs.map((paragraph, index) => <p key={`${index}-${paragraph.slice(0, 24)}`}>{paragraph}</p>)}
      </div>
    </section>
  );
}
