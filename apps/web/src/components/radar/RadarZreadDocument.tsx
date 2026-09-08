'use client';

import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Code2, ExternalLink, Eye, FileCode2, GitBranch, GitCommitHorizontal, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';

import MarkdownContent from '../MarkdownContent';
import { isZreadRepository, ZREAD_SAMPLE_URL } from './radar-repository';
import { cn } from '@/lib/utils';
import {
  decodeRadarTextEscapes,
  radarBlockId,
  radarQuoteMatchesBlock,
  splitRadarReadingBlocks,
} from './radar-reading-blocks';
import { highlightAnnotationQuotes } from './RadarOriginalArticle';
import { repoSummariesOverlap } from './RadarRepoSummary';

export { isZreadRepository, ZREAD_SAMPLE_URL };

// Kept as a compatibility alias for existing imports during the rollout.
export const isZreadSampleRepository = isZreadRepository;

interface Page {
  path?: string;
  title?: string;
  content?: string;
  group?: string;
  section?: string;
  sourceRefs?: Array<{ path: string; line?: number }>;
}

interface PreparedPage extends Page {
  id: string;
  blocks: Array<{ content: string; blockIndex: number }>;
}

interface SourceReference {
  path: string;
  line?: number;
}

type SourceViewMode = 'source' | 'preview';
type SourceRenderKind = 'html' | 'markdown' | 'unsupported';

interface Props {
  repositoryUrl: string;
  leftColRef: React.RefObject<HTMLDivElement | null>;
  aiBrief?: string | null;
  projectSummary?: string | null;
  /** The detail page may already present the unified intro summary. */
  showOverview?: boolean;
  meta: {
    language?: string | null;
    defaultBranch?: string | null;
    stars?: number | null;
    forks?: number | null;
    lastPushedAt?: string | null;
    description?: string | null;
    zread?: {
      provider?: 'zread-remote' | 'zread-cli' | 'github-readme-fallback' | string;
      status?: 'queued' | 'generating' | 'partial' | 'complete' | 'failed';
      commitSha?: string | null;
      generatedAt?: string | null;
      expectedPageCount?: number | null;
      error?: string | null;
      fallback?: boolean;
      pages?: Page[];
    } | null;
  } | null;
  onRefresh?: () => Promise<void> | void;
  onRetry?: () => Promise<void> | void;
  annotations?: Array<{ id: string; quote: string }>;
  selectedAnnotationId?: string | null;
  onAnnotationClick?: (annotationId: string) => void;
}

function formatCount(value: number | null | undefined): string | null {
  if (value == null) return null;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function resolveRepoReferences(markdown: string, repositoryUrl: string, ref: string): string {
  return markdown.replace(/\]\((?!https?:\/\/|mailto:|#)([^)\s]+)\)/gu, (_match, href: string) => {
    const [path, fragment] = href.split('#', 2);
    const target = `${repositoryUrl.replace(/\/$/u, '')}/blob/${ref}/${path.replace(/^\/+/u, '')}`;
    return `](${target}${fragment ? `#${fragment}` : ''})`;
  });
}

function repoFileUrl(repositoryUrl: string, ref: string, path?: string, line?: number): string {
  if (!path) return repositoryUrl;
  return `${repositoryUrl.replace(/\/$/u, '')}/blob/${ref}/${path.replace(/^\/+/u, '')}${line ? `#L${line}` : ''}`;
}

function repoTreeUrl(repositoryUrl: string, ref: string): string {
  return `${repositoryUrl.replace(/\/$/u, '')}/tree/${ref}`;
}

function rawRepoFileUrl(repositoryUrl: string, ref: string, path: string): string {
  const parsed = new URL(repositoryUrl);
  const segments = parsed.pathname.split('/').filter(Boolean);
  return `https://raw.githubusercontent.com/${segments.slice(0, 2).join('/')}/${encodeURIComponent(ref)}/${path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

function sourceRenderKind(path: string): SourceRenderKind {
  const normalized = path.split('?', 1)[0]?.toLowerCase() ?? '';
  if (/\.(?:html?|xhtml|svg)$/u.test(normalized)) return 'html';
  if (/\.(?:md|mdx)$/u.test(normalized)) return 'markdown';
  return 'unsupported';
}

function cleanDisplayText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .trim();
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function htmlPreviewDocument(content: string, baseUrl: string): string {
  const base = `<base href="${escapeHtmlAttribute(baseUrl)}">`;
  const style = `
    <style>
      :root { color-scheme: light dark; }
      body { margin: 1.25rem; font: 14px/1.7 system-ui, -apple-system, sans-serif; color: CanvasText; background: Canvas; }
      img, svg, video { max-width: 100%; height: auto; }
      pre, code { white-space: pre-wrap; overflow-wrap: anywhere; }
      pre { padding: .75rem; border-radius: .5rem; background: color-mix(in srgb, CanvasText 10%, Canvas); }
      table { max-width: 100%; border-collapse: collapse; overflow: auto; display: block; }
      th, td { border: 1px solid color-mix(in srgb, CanvasText 35%, Canvas); padding: .35rem .55rem; text-align: left; }
    </style>
  `;
  if (/<html(?:\s|>)/iu.test(content)) {
    if (/<head(?:\s|>)/iu.test(content)) {
      return content.replace(/<head(?:\s|>)/iu, (match) => `${match}${base}${style}`);
    }
    return content.replace(/<html(?:\s|>)/iu, (match) => `${match}<head>${base}${style}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${base}${style}</head><body>${content}</body></html>`;
}

function githubRepositoryKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    return segments.slice(0, 2).map((segment) => decodeURIComponent(segment).replace(/\.git$/u, '')).join('/');
  } catch {
    return null;
  }
}

function sourceReferenceFromGithubLink(
  href: string,
  repositoryUrl: string,
  ref: string,
): SourceReference | null {
  try {
    const parsed = new URL(href);
    if (parsed.hostname !== 'github.com' || githubRepositoryKey(href) !== githubRepositoryKey(repositoryUrl)) return null;
    const segments = parsed.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
    const kindIndex = segments.findIndex((segment) => segment === 'blob');
    if (kindIndex < 2 || kindIndex + 2 >= segments.length) return null;

    const currentRefMarker = `/blob/${ref}/`;
    const decodedPath = parsed.pathname.split('/').map((segment) => decodeURIComponent(segment)).join('/');
    const markerIndex = decodedPath.indexOf(currentRefMarker);
    const path = markerIndex >= 0
      ? decodedPath.slice(markerIndex + currentRefMarker.length)
      : segments.slice(kindIndex + 2).join('/');
    if (!path) return null;

    const lineMatch = parsed.hash.match(/^#L(\d+)/u);
    return { path, line: lineMatch ? Number(lineMatch[1]) : undefined };
  } catch {
    return null;
  }
}

function isGithubRepositoryTreeLink(href: string, repositoryUrl: string): boolean {
  try {
    const parsed = new URL(href);
    if (parsed.hostname !== 'github.com' || githubRepositoryKey(href) !== githubRepositoryKey(repositoryUrl)) return false;
    return parsed.pathname.split('/').filter(Boolean)[2] === 'tree';
  } catch {
    return false;
  }
}

function estimatedPageHeight(page: PreparedPage): number {
  const characters = page.blocks.reduce((total, block) => total + block.content.length, 0);
  return Math.min(18_000, Math.max(360, Math.round(characters * 0.36)));
}

function getScrollableRoot(ref: React.RefObject<HTMLElement | null>): HTMLElement | null {
  const root = ref.current;
  if (!root) return null;
  const style = getComputedStyle(root);
  return root.scrollHeight > root.clientHeight + 8
    && (style.overflowY === 'auto' || style.overflowY === 'scroll')
    ? root
    : null;
}

function LazyRepoPage({
  page,
  pageIndex,
  leftColRef,
  repositoryUrl,
  refName,
  onLinkClick,
  initiallyRendered = false,
}: {
  page: PreparedPage;
  pageIndex: number;
  leftColRef: React.RefObject<HTMLDivElement | null>;
  repositoryUrl: string;
  refName: string;
  onLinkClick: (href: string, event: React.MouseEvent<HTMLAnchorElement>) => void;
  initiallyRendered?: boolean;
}) {
  const pageRef = useRef<HTMLElement>(null);
  const [rendered, setRendered] = useState(pageIndex === 0 || initiallyRendered);

  useEffect(() => {
    if (initiallyRendered) setRendered(true);
  }, [initiallyRendered]);

  useEffect(() => {
    if (rendered) return;
    const root = getScrollableRoot(leftColRef);
    const target = pageRef.current;
    if (!target || typeof IntersectionObserver === 'undefined') {
      setRendered(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setRendered(true);
        observer.disconnect();
      },
      { root, rootMargin: '1200px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [leftColRef, pageIndex, rendered]);

  return (
    <section
      ref={pageRef}
      id={page.id}
      className="mb-14 scroll-mt-6 last:mb-0"
      style={rendered ? undefined : { minHeight: estimatedPageHeight(page) }}
    >
      {rendered ? (
        <>
          <div className="mb-4 flex items-center justify-end border-b border-[var(--ink-rule)] pb-2">
            <span className="text-[10px] text-[var(--ink-faint)]">第 {pageIndex + 1} 页</span>
          </div>
          <h2 className="mb-5 font-serif text-2xl font-semibold leading-tight text-[var(--ink-text)]">
            {page.title || `项目文档 ${pageIndex + 1}`}
          </h2>
          {page.blocks.map((block) => (
            <section
              key={radarBlockId(block.blockIndex)}
              id={radarBlockId(block.blockIndex)}
              data-radar-block="true"
              data-radar-block-index={block.blockIndex}
              className="group relative -mx-3 scroll-mt-6 rounded-md px-3 py-2 transition-colors"
              style={{ contentVisibility: 'auto', containIntrinsicSize: '280px' }}
            >
              <MarkdownContent
                content={resolveRepoReferences(block.content, repositoryUrl, refName)}
                className="text-[16px] text-[var(--ink-text)]"
                onLinkClick={onLinkClick}
              />
            </section>
          ))}
        </>
      ) : null}
    </section>
  );
}

export const RadarZreadDocument = memo(function RadarZreadDocument({
  repositoryUrl,
  leftColRef,
  aiBrief,
  meta,
  projectSummary,
  showOverview = true,
  onRefresh,
  onRetry,
  annotations = [],
  selectedAnnotationId,
  onAnnotationClick,
}: Props) {
  const cachedPages = useMemo(
    () => (meta?.zread?.pages ?? []).filter((page) => page.content?.trim()),
    [meta?.zread?.pages],
  );
  const provider = meta?.zread?.provider;
  const hasCachedWiki = (
    provider === 'zread-remote'
    || provider === 'zread-cli'
    || provider === 'github-readme-fallback'
  ) && cachedPages.length > 0;
  const isReadmeFallback = provider === 'github-readme-fallback' || meta?.zread?.fallback === true;
  const status = meta?.zread?.status ?? 'queued';
  const expectedPageCount = meta?.zread?.expectedPageCount ?? null;
  const isPartialCache = status === 'partial'
    || Boolean(expectedPageCount && cachedPages.length < expectedPageCount);
  const cacheStatus = isPartialCache
    ? '部分完成'
    : status === 'complete'
      ? '已完成'
      : status === 'failed'
        ? '生成失败'
        : status === 'generating'
          ? '生成中'
          : '尚未生成';
  const cachedPageLabel = meta?.zread?.expectedPageCount
    ? `${cachedPages.length}/${meta.zread.expectedPageCount} 页`
    : `${cachedPages.length} 页`;
  const displayCommit = meta?.zread?.commitSha || meta?.defaultBranch || '未生成';
  const displayGeneratedAt = meta?.zread?.generatedAt?.slice(0, 10) || '—';
  const providerLabel = isReadmeFallback
    ? 'GitHub README'
    : provider === 'zread-remote'
      ? 'Zread'
      : provider === 'zread-cli'
        ? 'Zread CLI（历史缓存）'
        : '项目文档';
  const zreadUrl = repositoryUrl.replace(/^https?:\/\/github\.com\//u, 'https://zread.ai/').replace(/\/$/u, '');
  const [activeId, setActiveId] = useState('repo-doc-page-0');
  const [retrying, setRetrying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [sourcePreview, setSourcePreview] = useState<SourceReference | null>(null);
  const [sourceContent, setSourceContent] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceViewMode, setSourceViewMode] = useState<SourceViewMode>('source');
  const [sourceListOpen, setSourceListOpen] = useState(false);
  const sourceDetailsRef = useRef<HTMLDetailsElement>(null);
  const ref = meta?.zread?.commitSha || meta?.defaultBranch || 'main';

  const pages = useMemo<PreparedPage[]>(() => {
    let blockIndex = 0;
    return cachedPages.map((page, pageIndex) => {
      const blocks = splitRadarReadingBlocks(page.content ?? '').map((content) => ({
        content,
        blockIndex: blockIndex++,
      }));
      return {
        ...page,
        path: page.path ? decodeRadarTextEscapes(page.path) : page.path,
        title: page.title ? decodeRadarTextEscapes(page.title) : page.title,
        group: page.group ? decodeRadarTextEscapes(page.group) : page.group,
        section: page.section ? decodeRadarTextEscapes(page.section) : page.section,
        id: `repo-doc-page-${pageIndex}`,
        blocks,
      };
    });
  }, [cachedPages]);
  const annotationPageIndices = useMemo(() => {
    const indices = new Set<number>();
    if (!annotations.length) return indices;
    pages.forEach((page, pageIndex) => {
      if (annotations.some((annotation) => (
        page.blocks.some((block) => radarQuoteMatchesBlock(block.content, annotation.quote))
      ))) {
        indices.add(pageIndex);
      }
    });
    return indices;
  }, [annotations, pages]);

  const groupedPages = useMemo(() => {
    const groups = new Map<string, Map<string, Array<(typeof pages)[number]>>>();
    for (const page of pages) {
      // Zread calls its top-level buckets "section" (Get Started/Buzz/
      // Deep Dive) and the nested buckets "group" (Hooks/Adapters/etc.).
      const groupName = page.section?.trim() || '项目文档';
      const sectionName = page.group?.trim() || '';
      const sections = groups.get(groupName) ?? new Map<string, Array<(typeof pages)[number]>>();
      const sectionPages = sections.get(sectionName) ?? [];
      sectionPages.push(page);
      sections.set(sectionName, sectionPages);
      groups.set(groupName, sections);
    }
    return [...groups.entries()].map(([group, sections]) => ({ group, sections: [...sections.entries()] }));
  }, [pages]);

  const sourceRefs = useMemo(() => {
    const seen = new Set<string>();
    const refs = pages.flatMap((page) => {
      const structured = (page.sourceRefs ?? []).map((source) => ({
        ...source,
        path: source.path.split('?', 1)[0] ?? source.path,
      }));
      const fromContent = [...(page.content ?? '').matchAll(
        /https?:\/\/github\.com\/[^/\s)]+\/[^/\s)]+\/blob\/[^/\s)]+\/([^)\s#]+)(?:#L(\d+)(?:-L\d+)?)?/gu,
      )].map((match) => ({
        path: (match[1] ?? '').split('?', 1)[0] ?? '',
        line: match[2] ? Number(match[2]) : undefined,
      }));
      return [...structured, ...fromContent];
    });
    return refs
      .filter((source) => source.path?.trim())
      .filter((source) => {
        const key = `${source.path}:${source.line ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
  }, [pages]);

  useEffect(() => {
    if (!sourcePreview) {
      setSourceContent('');
      setSourceError(null);
      return;
    }
    const controller = new AbortController();
    setSourceLoading(true);
    setSourceError(null);
    fetch(rawRepoFileUrl(repositoryUrl, ref, sourcePreview.path), {
      signal: controller.signal,
      cache: 'force-cache',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`源码读取失败（${response.status}）`);
        return response.text();
      })
      .then((content) => {
        if (!controller.signal.aborted) setSourceContent(content);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setSourceContent('');
          setSourceError(error instanceof Error ? error.message : '源码读取失败');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setSourceLoading(false);
      });
    return () => controller.abort();
  }, [ref, repositoryUrl, sourcePreview]);

  useEffect(() => {
    setSourceViewMode('source');
  }, [sourcePreview?.path]);

  useEffect(() => {
    if (!sourceListOpen) return;
    const frame = window.requestAnimationFrame(() => {
      sourceDetailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sourceListOpen]);

  useEffect(() => {
    const root = leftColRef.current;
    if (!root) return;
    const sections = pages
      .map((page) => document.getElementById(page.id))
      .filter((section): section is HTMLElement => Boolean(section));
    if (!sections.length || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) setActiveId(visible.target.id);
      },
      { root, rootMargin: '-12% 0px -68% 0px', threshold: [0, 0.2, 0.6] },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [leftColRef, pages]);

  useEffect(() => {
    const root = leftColRef.current?.querySelector<HTMLElement>('[data-zread-article]');
    if (!root) return;
    highlightAnnotationQuotes(root, annotations, { selectedAnnotationId, onAnnotationClick });
    return () => {
      root.querySelectorAll<HTMLElement>('.radar-user-annotation').forEach((mark) => {
        mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
      });
    };
  }, [annotations, leftColRef, onAnnotationClick, pages, selectedAnnotationId]);

  async function retryGeneration() {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  async function refreshDocument() {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await onRefresh();
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : '项目文档刷新失败');
    } finally {
      setRefreshing(false);
    }
  }

  function handleDocumentLinkClick(href: string, event: React.MouseEvent<HTMLAnchorElement>) {
    const source = sourceReferenceFromGithubLink(href, repositoryUrl, ref);
    if (source) {
      event.preventDefault();
      setSourcePreview(source);
      return;
    }
    if (isGithubRepositoryTreeLink(href, repositoryUrl)) {
      event.preventDefault();
      setSourceListOpen(true);
    }
  }

  const summary = cleanDisplayText(projectSummary);
  const brief = cleanDisplayText(aiBrief);
  const description = cleanDisplayText(meta?.description);
  const showBrief = Boolean(brief && (!summary || !repoSummariesOverlap(brief, summary)));
  const overview = summary || (showBrief ? brief : description);
  const overviewLabel = summary
    ? '项目解读'
    : showBrief
      ? 'AI 一句话解读'
      : description
        ? '项目简介'
        : '项目文档';

  return (
    <section data-testid="repo-document" className="mb-8">
      {showOverview ? (
        <div className="mb-7 border-y border-[var(--ink-rule)] py-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-accent)]">{overviewLabel}</p>
              {overview ? (
                <p className="mt-2 max-w-3xl font-serif text-sm leading-6 text-[var(--ink-muted)]">{overview}</p>
              ) : null}
              {showBrief && summary ? (
                <div className="mt-3 max-w-3xl rounded-md border-l-2 border-[var(--ink-accent)] bg-[var(--ink-paper)]/70 px-3 py-2.5">
                  <p className="mb-1 text-[11px] font-medium text-[var(--ink-muted)]">AI 一句话解读</p>
                  <p className="font-serif text-sm leading-6 text-[var(--ink-text)]">{brief}</p>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--ink-muted)]">
                <span>{cachedPageLabel}</span>
                <span>{providerLabel}</span>
              </div>
              {onRefresh ? (
                <button
                  type="button"
                  onClick={() => void refreshDocument()}
                  disabled={refreshing}
                  className="inline-flex items-center gap-1.5 border border-[var(--ink-rule)] px-3 py-1.5 text-xs font-medium text-[var(--ink-text)] transition-colors hover:border-[var(--ink-accent)] hover:text-[var(--ink-accent)] disabled:cursor-wait disabled:opacity-50"
                >
                  <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
                  {refreshing ? '刷新中…' : '刷新文档'}
                </button>
              ) : null}
            </div>
          </div>
          {refreshError ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {refreshError}，已保留上次文档。
            </p>
          ) : null}
          <details className="mt-3 text-[11px] text-[var(--ink-faint)]">
            <summary className="cursor-pointer select-none hover:text-[var(--ink-accent)]">来源与仓库信息</summary>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
              {meta?.language ? <span>{meta.language}</span> : null}
              {meta?.defaultBranch ? <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{meta.defaultBranch}</span> : null}
              {formatCount(meta?.stars) ? <span>★ {formatCount(meta?.stars)}</span> : null}
              {formatCount(meta?.forks) ? <span>⑂ {formatCount(meta?.forks)} forks</span> : null}
              <span>缓存于 {displayGeneratedAt}</span>
              <span className="inline-flex items-center gap-1"><GitCommitHorizontal className="size-3" />commit {displayCommit === '未生成' ? displayCommit : displayCommit.slice(0, 8)}</span>
            </div>
          </details>
        </div>
      ) : null}

      {!showOverview && onRefresh ? (
        <div className="mb-7 flex flex-wrap items-center justify-between gap-3 border-y border-[var(--ink-rule)] py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-accent)]">项目文档</p>
            <p className="mt-1 text-[11px] text-[var(--ink-muted)]">
              {cachedPageLabel} · {providerLabel} · {cacheStatus}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refreshDocument()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 border border-[var(--ink-rule)] px-3 py-1.5 text-xs font-medium text-[var(--ink-text)] transition-colors hover:border-[var(--ink-accent)] hover:text-[var(--ink-accent)] disabled:cursor-wait disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
            {refreshing ? '刷新中…' : '刷新文档'}
          </button>
          {refreshError ? (
            <p role="alert" className="basis-full text-xs text-destructive">
              {refreshError}，已保留上次文档。
            </p>
          ) : null}
        </div>
      ) : null}

      {isPartialCache || isReadmeFallback ? (
        <div className="mb-7 flex items-start gap-2 rounded-md border border-warning-border/60 bg-warning-bg px-4 py-3 text-xs leading-5 text-warning-fg">
          <Sparkles className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {isReadmeFallback
              ? '当前仅展示 GitHub README；Zread 没有可用的完整项目文档。'
              : `当前项目文档为部分缓存（${cachedPageLabel}），未覆盖的章节不会被标记为已读。`}
            {meta?.zread?.error ? ` ${meta.zread.error}` : ''}
          </span>
        </div>
      ) : null}

      {status === 'failed' ? (
        <div className="mb-7 rounded-md border border-status-failed-border/60 bg-status-failed-bg px-4 py-3 text-xs leading-5 text-status-failed-fg">
          <p><strong>项目文档生成失败。</strong>{meta?.zread?.error || '当前没有可展示的项目正文。'}</p>
          {onRetry ? (
            <button type="button" onClick={() => void retryGeneration()} disabled={retrying} className="mt-2 border border-status-failed-border bg-background px-2 py-1 font-medium hover:bg-status-failed-bg disabled:opacity-50">
              {retrying ? '正在重新投递…' : '重试抓取'}
            </button>
          ) : null}
        </div>
      ) : null}

      {hasCachedWiki ? (
        <div className="lg:grid lg:grid-cols-[220px_28px_minmax(0,1fr)] lg:items-start">
          <nav className="sticky top-5 hidden h-[calc(100dvh-12rem)] max-h-[calc(100dvh-12rem)] overscroll-contain overflow-y-auto pr-2 lg:block" aria-label="项目文档目录">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-accent)]">文档目录</p>
            <div className="space-y-3 border-l border-[var(--ink-rule)] pl-3">
              {groupedPages.map(({ group, sections }) => (
                <details key={group} open>
                  <summary className="cursor-pointer py-1 text-[11px] font-semibold text-[var(--ink-text)]">{group}</summary>
                  <div className="mt-1 space-y-2">
                    {sections.map(([section, sectionPages]) => (
                      <div key={section || 'default'}>
                        {section ? <p className="px-1 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--ink-faint)]">{section}</p> : null}
                        <ol className="space-y-0.5">
                          {sectionPages.map((page, index) => (
                            <li key={page.id}>
                              <a
                                href={`#${page.id}`}
                                aria-current={activeId === page.id ? 'location' : undefined}
                                className={cn(
                                  'flex items-start gap-2 py-1 text-xs leading-5 transition-colors',
                                  activeId === page.id
                                    ? 'font-semibold text-[var(--ink-accent)]'
                                    : 'text-[var(--ink-muted)] hover:text-[var(--ink-accent)]',
                                )}
                              >
                                <FileCode2 className="mt-0.5 size-3 shrink-0" />
                                <span>{page.title || page.path || `文档 ${index + 1}`}</span>
                              </a>
                            </li>
                          ))}
                        </ol>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </nav>
          <div className="hidden min-h-[520px] border-x border-[var(--ink-rule)] lg:block" aria-hidden />
          <div className="min-w-0 lg:pl-8">
            <details className="mb-6 rounded-lg border border-[var(--ink-rule)] lg:hidden">
              <summary className="cursor-pointer px-3 py-2.5 text-xs font-semibold text-[var(--ink-text)]">文档目录</summary>
              <div className="space-y-3 border-t border-[var(--ink-rule)] px-3 py-2">
                {groupedPages.map(({ group, sections }) => (
                  <details key={group} open>
                    <summary className="cursor-pointer py-1 text-xs font-semibold text-[var(--ink-text)]">{group}</summary>
                    <div className="mt-1 space-y-2 pl-2">
                      {sections.map(([section, sectionPages]) => (
                        <div key={section || 'default'}>
                          {section ? <p className="py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--ink-faint)]">{section}</p> : null}
                          <ol>
                            {sectionPages.map((page, index) => (
                              <li key={page.id}>
                                <a href={`#${page.id}`} className="block py-1.5 text-xs text-[var(--ink-muted)] hover:text-[var(--ink-accent)]">
                                  {page.title || page.path || `文档 ${index + 1}`}
                                </a>
                              </li>
                            ))}
                          </ol>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </details>

            <div data-zread-article data-radar-reading-body="true" className="reading-workbench-markdown text-[16px] text-[var(--ink-text)] selection:bg-[var(--ink-accent)]/20">
              {pages.map((page, pageIndex) => (
                <LazyRepoPage
                  key={page.id}
                  page={page}
                  pageIndex={pageIndex}
                  leftColRef={leftColRef}
                  repositoryUrl={repositoryUrl}
                  refName={ref}
                  onLinkClick={handleDocumentLinkClick}
                  initiallyRendered={annotationPageIndices.has(pageIndex)}
                />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="max-w-2xl border-l-2 border-[var(--ink-rule)] py-2 pl-4 text-sm leading-7 text-[var(--ink-muted)]">
          <h2 className="font-serif text-lg font-semibold text-[var(--ink-text)]">
            {status === 'generating' ? '正在抓取项目文档' : '暂时没有项目文档'}
          </h2>
          <p className="mt-1">
            {status === 'generating'
              ? '后台正在读取现有 Zread 页面；若不可用，将回退到 GitHub README。'
              : '没有找到可用的 Zread 页面或 README，因此这里不展示推测生成的目录。'}
          </p>
          {onRetry ? (
            <button type="button" onClick={() => void retryGeneration()} disabled={retrying} className="mt-3 border border-[var(--ink-rule)] px-3 py-1.5 text-xs font-medium text-[var(--ink-text)] hover:bg-muted disabled:opacity-50">
              {retrying ? '正在重新投递…' : '重新抓取'}
            </button>
          ) : null}
        </div>
      )}

      {hasCachedWiki && sourceRefs.length ? (
        <details
          ref={sourceDetailsRef}
          open={sourceListOpen}
          onToggle={(event) => setSourceListOpen(event.currentTarget.open)}
          className="mt-7 border-y border-[var(--ink-rule)] py-3"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-semibold text-[var(--ink-text)]">
            <span className="inline-flex items-center gap-2"><FileCode2 className="size-3.5 text-[var(--ink-accent)]" />Source · 查看引用源码</span>
            <span className="text-[10px] font-normal text-[var(--ink-faint)]">固定到 commit {ref.slice(0, 8)}</span>
          </summary>
          <div className="mt-3 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {sourceRefs.map((source) => (
              <button
                type="button"
                key={`${source.path}:${source.line ?? ''}`}
                onClick={() => setSourcePreview(source)}
                className="truncate rounded px-2 py-1.5 text-left font-mono text-[11px] text-[var(--ink-muted)] hover:bg-muted hover:text-[var(--ink-accent)]"
              >
                {source.path}{source.line ? ` · L${source.line}` : ''}
              </button>
            ))}
          </div>
        </details>
      ) : null}

      {sourcePreview ? (
        <aside
          data-testid="radar-source-preview"
          aria-label={`源码预览：${sourcePreview.path}`}
          className="fixed inset-y-16 right-4 z-[9975] flex w-[min(620px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        >
          <header className="flex shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
            <FileCode2 className="size-4 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-mono text-xs font-semibold text-foreground">{sourcePreview.path}</h2>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                commit {ref.slice(0, 8)}
                {sourcePreview.line ? ` · 引用行 L${sourcePreview.line}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 items-center rounded-md border border-border p-0.5" role="group" aria-label="源码查看方式">
              <button
                type="button"
                aria-pressed={sourceViewMode === 'source'}
                onClick={() => setSourceViewMode('source')}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] transition-colors',
                  sourceViewMode === 'source' ? 'bg-muted font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Code2 className="size-3" />源码
              </button>
              <button
                type="button"
                aria-pressed={sourceViewMode === 'preview'}
                disabled={sourceRenderKind(sourcePreview.path) === 'unsupported'}
                onClick={() => setSourceViewMode('preview')}
                title={sourceRenderKind(sourcePreview.path) === 'unsupported' ? '该文件类型暂不支持渲染预览' : '渲染预览'}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] transition-colors',
                  sourceViewMode === 'preview' ? 'bg-muted font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground',
                  sourceRenderKind(sourcePreview.path) === 'unsupported' && 'cursor-not-allowed opacity-40',
                )}
              >
                <Eye className="size-3" />渲染预览
              </button>
            </div>
            <button
              type="button"
              aria-label="关闭源码预览"
              onClick={() => setSourcePreview(null)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto bg-muted/20 p-3">
            {sourceLoading ? (
              <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />正在读取引用源码…
              </div>
            ) : sourceError ? (
              <div role="alert" className="rounded-md border border-warning-border bg-warning-bg p-3 text-xs leading-5 text-warning-fg">
                {sourceError}
              </div>
            ) : sourceViewMode === 'preview' ? (
              sourceRenderKind(sourcePreview.path) === 'html' ? (
                <iframe
                  title={`渲染预览：${sourcePreview.path}`}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={htmlPreviewDocument(sourceContent, `${rawRepoFileUrl(repositoryUrl, ref, sourcePreview.path).replace(/\/[^/]+$/u, '/')}`)}
                  className="min-h-[calc(100dvh-11rem)] w-full rounded-md border border-border bg-background"
                />
              ) : sourceRenderKind(sourcePreview.path) === 'markdown' ? (
                <div className="rounded-md bg-background p-5">
                  <MarkdownContent content={sourceContent} compact className="text-sm" />
                </div>
              ) : (
                <div className="rounded-md border border-border bg-background p-4 text-xs leading-5 text-muted-foreground">
                  该文件类型暂不支持渲染预览，请切换回源码查看。
                </div>
              )
            ) : (
              <pre className="min-w-max font-mono text-[12px] leading-5 text-foreground">
                {sourceContent.split('\n').map((line, index) => {
                  const lineNumber = index + 1;
                  const active = lineNumber === sourcePreview.line;
                  return (
                    <code
                      key={lineNumber}
                      data-source-line={lineNumber}
                      className={cn('block px-2', active && 'rounded-sm bg-warning-bg')}
                    >
                      <span className="mr-4 inline-block w-10 select-none text-right text-muted-foreground/60">{lineNumber}</span>
                      {line || ' '}
                    </code>
                  );
                })}
              </pre>
            )}
          </div>
        </aside>
      ) : null}

      <div className="mt-7 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--ink-rule)] pt-3 text-[10px] text-[var(--ink-faint)]">
        <span>{providerLabel} · {cacheStatus}</span>
        <span>commit {displayCommit === '未生成' ? displayCommit : displayCommit.slice(0, 8)}</span>
        {provider === 'zread-remote' ? (
          <a href={zreadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--ink-accent)] hover:underline">
            查看 Zread 来源 <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>
    </section>
  );
});
