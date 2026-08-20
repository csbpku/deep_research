'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Copy, Download, Languages, Loader2, MessageCircle, Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { RadarGuide } from './RadarAiReadingTab';

export interface ActiveRadarBlock {
  index: number;
  content: string;
  blockCount?: number;
}

interface RadarRightPanelProps {
  summaryId: string;
  onHighlightClick?: (quote: string, sourceBlockIndex?: number, anchorId?: string) => void;
  canInteract?: boolean;
  annotationRefreshKey?: number;
  selectedQuote?: string | null;
  onExplainSelection?: () => void;
  onTranslateSelection?: () => void;
  onAnnotateSelection?: () => void;
  onCopySelection?: () => void;
  onAskSelection?: () => void;
  className?: string;
}

type Coverage = {
  sourceChars?: number;
  processedChars?: number;
  complete?: boolean;
  outlineCount?: number;
  resolvedOutlineCount?: number;
};
type MapState = { guide: RadarGuide | null; loading: boolean; error: string | null; cached: boolean; coverage: Coverage | null };
type OutlineItem = { heading?: string; takeaway?: string; quote?: string; sourceBlockIndex?: number; anchorStatus?: 'resolved' | 'unresolved' };
type Annotation = {
  id: string;
  quote: string;
  body?: string | null;
  createdAt?: string;
};

/** The right rail is deliberately only a document map. The article remains the primary reading surface. */
export function RadarRightPanel({ summaryId, onHighlightClick, canInteract = false, annotationRefreshKey = 0, selectedQuote, onExplainSelection, onTranslateSelection, onAnnotateSelection, onCopySelection, onAskSelection, className }: RadarRightPanelProps) {
  const [mapState, setMapState] = useState<MapState>({ guide: null, loading: false, error: null, cached: false, coverage: null });
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const loadingRef = useRef(false);

  const generateMap = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setMapState({ guide: null, loading: true, error: null, cached: false, coverage: null });
    try {
      const response = await fetch(`/api/radar/${summaryId}/transform`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'ai_reading', language: 'zh-CN' }),
      });
      const body = (await response.json().catch(() => ({}))) as { guide?: RadarGuide | null; cached?: boolean; message?: string; coverage?: Coverage };
      if (!response.ok || !body.guide) throw new Error(body.message ?? '文章地图暂时不可用');
      setMapState({ guide: body.guide, loading: false, error: null, cached: body.cached === true, coverage: body.coverage ?? null });
    } catch (error) {
      setMapState({ guide: null, loading: false, error: error instanceof Error ? error.message : '文章地图暂时不可用', cached: false, coverage: null });
    } finally {
      loadingRef.current = false;
    }
  }, [summaryId]);

  useEffect(() => {
    void generateMap();
  }, [generateMap]);

  useEffect(() => {
    if (!canInteract) {
      setAnnotations([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/radar/annotations?summaryId=${encodeURIComponent(summaryId)}&mine=true`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ annotations?: Annotation[] }>;
      })
      .then((body) => {
        if (!cancelled) setAnnotations(body?.annotations ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [annotationRefreshKey, canInteract, summaryId]);

  function exportAnnotations() {
    if (!annotations.length) return;
    const markdown = annotations.map((item) => {
      const note = item.body?.trim() ? `\n\n${item.body.trim()}` : '';
      return `> ${item.quote.replace(/\n/gu, '\n> ')}${note}`;
    }).join('\n\n');
    const blob = new Blob([`# 我的雷达批注\n\n${markdown}\n`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `radar-${summaryId}-annotations.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const outline = mapState.guide?.outline ?? [];
  // Keep the rail exclusively AI-generated. While the request is pending,
  // do not fall back to the source headings — that makes the original TOC
  // look like a generated map and creates two competing loading states.
  const displayOutline = outline;

  return (
    <aside className={cn('flex h-full min-h-0 flex-col', className)} aria-label="文章地图">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <p className="font-sans text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-accent)]">阅读导航</p>
          <h2 className="mt-1 font-sans text-lg font-semibold text-[var(--ink-text)]">文章地图</h2>
          <p className="mt-1 max-w-[30ch] text-xs leading-5 text-[var(--ink-muted)]">原文是主阅读区；点击有可靠引用的条目可回到原文位置。</p>
          {!mapState.loading && !mapState.error && mapState.guide ? (
            <div className="mt-2 space-y-1 text-[10px] text-[var(--ink-faint)]">
              <p>{mapState.cached ? '已使用本地缓存' : '刚刚生成并已缓存'}</p>
              {mapState.coverage ? (
                <p>
                  结构分析 {mapState.coverage.complete === false ? '部分覆盖' : '完整'}
                  {typeof mapState.coverage.outlineCount === 'number'
                    ? ` · 回链 ${mapState.coverage.resolvedOutlineCount ?? 0}/${mapState.coverage.outlineCount}`
                    : ''}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <Sparkles className="mt-1 size-4 shrink-0 text-[var(--ink-accent)]" aria-hidden />
      </div>

      {mapState.loading ? <Loading label="正在生成 AI 文章地图" /> : null}
      {mapState.error ? (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-800">
          {mapState.error}
          <button type="button" onClick={() => void generateMap()} className="mt-2 block font-medium underline">重试</button>
        </div>
      ) : null}

      {selectedQuote ? (
        <div className="mb-4 border-y border-[var(--ink-rule)] py-3">
          <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-accent)]">
            <Sparkles className="size-3" />
            当前选中文本
          </div>
          <p className="line-clamp-3 font-serif text-xs leading-5 text-[var(--ink-muted)]">{selectedQuote}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" onClick={onExplainSelection} className="inline-flex items-center gap-1 border border-[var(--ink-accent)]/35 px-2 py-1 text-[11px] font-medium text-[var(--ink-accent)] hover:bg-[var(--ink-accent)]/[0.06]">
              <Sparkles className="size-3" />解释
            </button>
            <button type="button" onClick={onTranslateSelection} className="inline-flex items-center gap-1 border border-amber-300 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-50">
              <Languages className="size-3" />翻译
            </button>
            <button type="button" onClick={onAskSelection} className="inline-flex items-center gap-1 border border-method-ai/35 px-2 py-1 text-[11px] font-medium text-method-ai hover:bg-method-ai/10">
              <MessageCircle className="size-3" />问 AI
            </button>
            <button type="button" onClick={onAnnotateSelection} className="inline-flex items-center gap-1 border border-[var(--ink-rule)] px-2 py-1 text-[11px] font-medium text-[var(--ink-text)] hover:bg-[var(--ink-page)]">
              <BookmarkPlus className="size-3" />批注
            </button>
            <button type="button" onClick={onCopySelection} className="inline-flex items-center gap-1 border border-[var(--ink-rule)] px-2 py-1 text-[11px] font-medium text-[var(--ink-text)] hover:bg-[var(--ink-page)]">
              <Copy className="size-3" />复制
            </button>
          </div>
        </div>
      ) : null}

      {!mapState.loading && !mapState.error && !displayOutline.length ? (
        <div className="rounded-lg border border-dashed border-[var(--ink-rule)] bg-white/60 p-4">
          <p className="font-serif text-sm leading-6 text-[var(--ink-text)]">文章地图暂时没有可展示的结构。</p>
          <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">AI 已自动尝试生成；如果文章缺少清晰章节，可直接按左侧原文阅读。</p>
        </div>
      ) : null}

      {displayOutline.length ? (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
          <p className="mb-2 text-[11px] text-[var(--ink-muted)]">
            基于全文生成 · {outline.length} 个部分
          </p>
          {displayOutline.map((item, index) => (
            <div
              key={`${item.heading ?? 'section'}-${index}`}
              role={item.anchorStatus !== 'unresolved' && item.quote ? 'button' : undefined}
              tabIndex={item.anchorStatus !== 'unresolved' && item.quote ? 0 : undefined}
              className={cn(
                'border-b border-[var(--ink-rule)] px-1 py-3 transition-colors',
                item.anchorStatus !== 'unresolved' && item.quote
                  ? 'cursor-pointer hover:bg-[var(--ink-accent)]/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40'
                  : 'opacity-80',
              )}
              onClick={() => item.anchorStatus !== 'unresolved' && item.quote ? onHighlightClick?.(item.quote, item.sourceBlockIndex) : undefined}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  if (item.anchorStatus !== 'unresolved' && item.quote) {
                    onHighlightClick?.(item.quote, item.sourceBlockIndex);
                  }
                }
              }}
            >
              <div className="flex gap-2.5">
                <span className="font-mono text-[10px] text-[var(--ink-accent)]">{String(index + 1).padStart(2, '0')}</span>
                <div className="min-w-0">
                  <p className="font-sans text-xs font-semibold text-[var(--ink-text)]">{item.heading || `部分 ${index + 1}`}</p>
                  {item.takeaway ? <p className="mt-1 font-serif text-xs leading-5 text-[var(--ink-muted)]">{item.takeaway}</p> : null}
                  {item.anchorStatus === 'unresolved' || !item.quote ? (
                    <span className="mt-1 block text-[11px] text-[var(--ink-faint)]">暂无精确原文位置</span>
                  ) : (
                    <span className="mt-1 block text-[11px] text-[var(--ink-accent)]">回到原文 ↗</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {canInteract && annotations.length ? (
        <details className="mt-5 border-t border-[var(--ink-rule)] pt-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-semibold text-[var(--ink-text)] [&::-webkit-details-marker]:hidden">
            <span>我的批注 · {annotations.length}</span>
            <button
              type="button"
              onClick={(event) => { event.preventDefault(); exportAnnotations(); }}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--ink-accent)] hover:underline"
            >
              <Download className="size-3" />导出 Markdown
            </button>
          </summary>
          <div className="mt-3 space-y-2">
            {annotations.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onHighlightClick?.(item.quote)}
                className="block w-full border-l-2 border-[var(--ink-accent)]/60 bg-[var(--ink-page)] px-3 py-2 text-left text-xs leading-5 text-[var(--ink-muted)] hover:text-[var(--ink-accent)]"
              >
                <span className="block font-serif">“{item.quote}”</span>
                {item.body ? <span className="mt-1 block text-[11px] text-[var(--ink-faint)]">{item.body}</span> : null}
              </button>
            ))}
          </div>
        </details>
      ) : null}
    </aside>
  );
}

function Loading({ label }: { label: string }) {
  return <div className="flex items-center gap-2 rounded-md border border-[var(--ink-rule)] bg-white px-3 py-3 text-xs text-[var(--ink-muted)]"><Loader2 className="size-3.5 animate-spin text-[var(--ink-accent)]" />{label}</div>;
}
