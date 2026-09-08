// Phase 2A — Radar deep-dive: GitHub repo structured view.
//
// Pure presentational component. Receives originalMeta JSONB from the
// server (already enriched by packages/ai-engine/ai_engine/radar/
// enrichment_worker.py) and renders repo meta + file tree + entry
// points. Reference layout: zread.ai/{owner}/{repo}.
//
// We deliberately do NOT do any client-side fetching — the parent
// detail page already pulled the row, and shipping the meta inline
// keeps the SSR experience simple and avoids a flicker.

import { useMemo } from 'react';
import {
  CircleDot,
  Clock3,
  FileCode2,
  FileText,
  FolderOpen,
  GitBranch,
  GitFork,
  Radio,
  Star,
  Target,
} from 'lucide-react';

interface TreeNode {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
  key?: boolean;
}

interface RepoMeta {
  provider?: string;
  defaultBranch?: string | null;
  language?: string | null;
  stars?: number | null;
  forks?: number | null;
  openIssues?: number | null;
  lastPushedAt?: string | null;
  snapshotFetchedAt?: string | null;
  description?: string | null;
  tree?: TreeNode[];
  entryPoints?: string[];
  fetchedAt?: string;
  trimmed?: boolean;
}

interface Props {
  meta: RepoMeta;
  owner: string;
  repo: string;
}

// Group tree nodes into 2-level buckets so a top-level dir + its first
// few children show up together. We keep the rendering shallow to
// match the design (read at a glance, no expansion required for P0).
function bucketTree(tree: TreeNode[]): Array<{
  name: string;
  type: 'blob' | 'tree';
  key?: boolean;
  size?: number;
  children: TreeNode[];
}> {
  const topDirs = new Map<string, TreeNode[]>();
  const topFiles: TreeNode[] = [];
  for (const node of tree) {
    const slash = node.path.indexOf('/');
    if (slash === -1) {
      topFiles.push(node);
    } else {
      const top = node.path.slice(0, slash);
      const existing = topDirs.get(top);
      if (existing) {
        existing.push(node);
      } else {
        topDirs.set(top, [node]);
      }
    }
  }
  const buckets: Array<{
    name: string;
    type: 'blob' | 'tree';
    key?: boolean;
    size?: number;
    children: TreeNode[];
  }> = topFiles.map((f) => ({
    name: f.path,
    type: f.type as 'blob' | 'tree',
    key: f.key,
    size: f.size,
    children: [],
  }));
  for (const [dir, children] of topDirs) {
    const dirNode = tree.find((n) => n.path === dir);
    buckets.push({
      name: dir,
      type: 'tree',
      key: dirNode?.key,
      size: dirNode?.size,
      children: children.slice(0, 8),
    });
  }
  return buckets.sort((a, b) => {
    if (a.key && !b.key) return -1;
    if (b.key && !a.key) return 1;
    return a.name.localeCompare(b.name);
  });
}

function formatStars(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatSize(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function RadarRepoStructureCard({ meta, owner, repo }: Props) {
  const buckets = useMemo(() => bucketTree(meta.tree ?? []), [meta.tree]);
  const entryPoints = meta.entryPoints ?? [];

  return (
    <section className="mb-4 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      {/* Repo header */}
      <div className="border-b border-border bg-muted/30 px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <FolderOpen className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 break-all font-mono text-sm font-semibold text-foreground">
            {owner}/{repo}
          </span>
          {meta.language && (
            <span className="ml-auto shrink-0 rounded border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">
              {meta.language}
            </span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><Star className="size-3.5" aria-hidden />{formatStars(meta.stars)}</span>
          {meta.forks != null && <span className="inline-flex items-center gap-1.5"><GitFork className="size-3.5" aria-hidden />{formatStars(meta.forks)}</span>}
          {meta.openIssues != null && <span className="inline-flex items-center gap-1.5"><CircleDot className="size-3.5" aria-hidden />{meta.openIssues}</span>}
          {meta.defaultBranch && <span className="inline-flex items-center gap-1.5"><GitBranch className="size-3.5" aria-hidden />{meta.defaultBranch}</span>}
          {meta.lastPushedAt && (
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="size-3.5" aria-hidden />
              {new Date(meta.lastPushedAt).toLocaleDateString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
              })}
            </span>
          )}
          {meta.snapshotFetchedAt && (
            <span className="inline-flex items-center gap-1.5"><Radio className="size-3.5" aria-hidden />{new Date(meta.snapshotFetchedAt).toLocaleDateString('zh-CN')}</span>
          )}
        </div>
        {meta.description && (
          <div className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            {meta.description}
          </div>
        )}
      </div>

      {/* File tree */}
      <div className="border-b border-border px-4 py-4 sm:px-5">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-foreground">
          <FileCode2 className="size-3.5 text-primary" aria-hidden />
          <span>文件结构</span>
          <span className="font-normal text-muted-foreground">({buckets.length} 顶层)</span>
          {meta.trimmed && (
            <span className="ml-auto rounded border border-warning-border bg-warning-bg px-1.5 py-0.5 text-[11px] font-medium text-warning-fg">
              已截断
            </span>
          )}
        </div>
        <div className="space-y-1 font-mono text-xs leading-6 text-muted-foreground">
          {buckets.map((bucket) => (
            <div key={bucket.name}>
              <div className={bucket.key ? 'flex items-start gap-2 break-all font-semibold text-primary' : 'flex items-start gap-2 break-all text-foreground'}>
                {bucket.type === 'tree' ? <FolderOpen className="mt-1 size-3.5 shrink-0" aria-hidden /> : <FileText className="mt-1 size-3.5 shrink-0" aria-hidden />}
                <span className="min-w-0">{bucket.name}</span>
                {bucket.key && <span className="mt-0.5 shrink-0 text-[10px]" aria-label="关键入口">●</span>}
              </div>
              {bucket.children.length > 0 && (
                <div className="ml-2 mt-0.5 space-y-0.5 border-l border-border pl-4">
                  {bucket.children.map((child) => (
                    <div key={child.path} className={child.key ? 'flex items-start gap-2 break-all font-medium text-primary' : 'flex items-start gap-2 break-all'}>
                      <FileText className="mt-1 size-3 shrink-0" aria-hidden />
                      <span className="min-w-0">{child.path.replace(`${bucket.name}/`, '')}</span>
                      {child.key && <span className="mt-0.5 shrink-0 text-[10px]" aria-label="关键入口">●</span>}
                      {child.size != null && (
                        <span className="shrink-0 font-sans text-[11px] font-normal text-muted-foreground">({formatSize(child.size)})</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Entry points */}
      {entryPoints.length > 0 && (
        <div className="bg-muted/20 px-4 py-4 sm:px-5">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-foreground">
            <Target className="size-3.5 text-primary" aria-hidden />
            <span>入口点</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {entryPoints.map((ep) => (
              <code key={ep} className="break-all rounded border border-border bg-background px-2 py-1 font-mono text-xs text-primary">
                {ep}
              </code>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
