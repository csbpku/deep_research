import { CircleDot, GitPullRequest, MessageSquare, Package, Tag } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { RadarGithubItemMeta } from '../../lib/radar/shape';

const KIND_COPY: Record<RadarGithubItemMeta['kind'], { icon: LucideIcon; title: string }> = {
  issue: { icon: CircleDot, title: 'Issue 摘要' },
  pr: { icon: GitPullRequest, title: 'Pull Request 摘要' },
  release: { icon: Tag, title: 'Release 摘要' },
};

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('zh-CN');
}

export function RadarGithubItemSummary({ meta }: { meta: RadarGithubItemMeta }) {
  const copy = KIND_COPY[meta.kind];
  const Icon = copy.icon;
  const created = formatDate(meta.createdAt);
  const updated = formatDate(meta.updatedAt ?? meta.publishedAt);
  const identifier = meta.kind === 'release'
    ? (meta.tagName ?? meta.numberOrTag)
    : `#${meta.numberOrTag}`;

  return (
    <section className="my-5 border-y border-border py-4" aria-labelledby="github-item-summary-title">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="github-item-summary-title" className="flex items-center gap-1.5 text-sm font-semibold">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          {copy.title}
        </h2>
        <span className="font-mono text-xs text-muted-foreground">{meta.owner}/{meta.repo} {identifier}</span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {meta.state ? <span className="font-medium text-foreground/80">{meta.draft ? 'draft' : meta.state}</span> : null}
        {meta.author ? <span>由 {meta.author} 提交</span> : null}
        {created ? <span>创建于 {created}</span> : null}
        {updated ? <span>更新于 {updated}</span> : null}
        {meta.comments > 0 ? (
          <span className="inline-flex items-center gap-1"><MessageSquare className="size-3" />{meta.comments}</span>
        ) : null}
        {meta.kind === 'release' && meta.assetCount > 0 ? (
          <span className="inline-flex items-center gap-1"><Package className="size-3" />{meta.assetCount} 个附件</span>
        ) : null}
      </div>

      {meta.labels.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {meta.labels.map((label) => (
            <span key={label} className="border border-border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground">
              {label}
            </span>
          ))}
        </div>
      ) : null}

      {meta.bodyPreview ? (
        <div className="mb-4 grid gap-1 sm:grid-cols-[6rem_1fr] sm:gap-3">
          <h3 className="text-xs font-medium text-muted-foreground">变更摘要</h3>
          <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">{meta.bodyPreview}</p>
        </div>
      ) : null}

      {meta.commentPreviews.length > 0 ? (
        <div className="border-t border-border pt-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">关键讨论</h3>
          <div className="divide-y divide-border">
            {meta.commentPreviews.map((comment, index) => (
              <div key={`${comment.author ?? 'unknown'}-${index}`} className="grid gap-1 py-2.5 sm:grid-cols-[6rem_1fr] sm:gap-3">
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">{comment.author ?? '未知用户'}</span>
                  {formatDate(comment.createdAt) ? <div>{formatDate(comment.createdAt)}</div> : null}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6">{comment.body}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
