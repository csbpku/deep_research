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
  lastPushedAt?: string | null;
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
    <section
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 10,
        background: '#fff',
        overflow: 'hidden',
        marginBottom: 16,
      }}
    >
      {/* Repo header */}
      <div
        style={{
          padding: '14px 18px',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
          color: '#f1f5f9',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>📦</span>
          <span style={{ fontWeight: 600, fontSize: 16 }}>
            {owner}/{repo}
          </span>
          {meta.language && (
            <span
              style={{
                marginLeft: 'auto',
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                background: '#334155',
                color: '#cbd5e1',
              }}
            >
              {meta.language}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#94a3b8' }}>
          <span>⭐ {formatStars(meta.stars)}</span>
          {meta.defaultBranch && <span>🌿 {meta.defaultBranch}</span>}
          {meta.lastPushedAt && (
            <span>
              🕒{' '}
              {new Date(meta.lastPushedAt).toLocaleDateString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
              })}
            </span>
          )}
        </div>
        {meta.description && (
          <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 4 }}>
            {meta.description}
          </div>
        )}
      </div>

      {/* File tree */}
      <div style={{ padding: '12px 18px', borderTop: '1px solid #e2e8f0' }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: '#475569',
            marginBottom: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span>🌳</span>
          <span>文件结构</span>
          <span style={{ color: '#94a3b8', fontWeight: 400 }}>
            ({buckets.length} 顶层)
          </span>
          {meta.trimmed && (
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 10,
                color: '#92400e',
                background: '#fef3c7',
                padding: '2px 6px',
                borderRadius: 3,
              }}
            >
              已截断
            </span>
          )}
        </div>
        <div
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, monospace',
            fontSize: 12,
            color: '#334155',
            lineHeight: 1.7,
          }}
        >
          {buckets.map((bucket) => (
            <div key={bucket.name} style={{ marginBottom: 4 }}>
              <span
                style={{
                  color: bucket.key ? '#0f766e' : '#475569',
                  fontWeight: bucket.key ? 600 : 400,
                }}
              >
                {bucket.type === 'tree' ? '📁' : '📄'} {bucket.name}
                {bucket.key && ' ⭐'}
              </span>
              {bucket.children.length > 0 && (
                <div style={{ paddingLeft: 20, color: '#64748b' }}>
                  {bucket.children.map((child) => (
                    <div key={child.path}>
                      📄 {child.path.replace(`${bucket.name}/`, '')}
                      {child.key && (
                        <span style={{ color: '#0f766e' }}> ⭐</span>
                      )}
                      {child.size != null && (
                        <span
                          style={{
                            color: '#94a3b8',
                            fontSize: 11,
                            marginLeft: 6,
                          }}
                        >
                          ({formatSize(child.size)})
                        </span>
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
        <div
          style={{
            padding: '12px 18px',
            borderTop: '1px solid #e2e8f0',
            background: '#f8fafc',
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: '#475569',
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span>🎯</span>
            <span>入口点</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {entryPoints.map((ep) => (
              <code
                key={ep}
                style={{
                  padding: '2px 8px',
                  background: '#fff',
                  border: '1px solid #cbd5e1',
                  borderRadius: 4,
                  fontSize: 12,
                  color: '#0f766e',
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                }}
              >
                {ep}
              </code>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}