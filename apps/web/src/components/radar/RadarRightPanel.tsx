'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Check, Copy, Crosshair, Download, ChevronDown, Languages, Loader2, MessageCircle, Pencil, Sparkles, Trash2, X } from 'lucide-react';

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
  /** 正文原文 — 用于判断是否已达到 map 生成阈值 */
  rawReadingBody?: string;
  /** 正文是否仍在补抓,等待补抓完成再生 map 避免空内容触发 AI 调用 */
  contentPending?: boolean;
  /** 首屏摘要已到，但正文请求尚未完成。 */
  contentLoading?: boolean;
  /** AI 地图生成期间显示的确定性原文目录，避免右栏空白或只剩 spinner。 */
  sourceTitle?: string;
  /** skim 层只允许展示来源标题，不暴露正文或可回链引用。 */
  sourceOutline?: Array<{ heading: string; level: number }> | null;
  /** skim 层只展示来源大纲，不生成或命名为 AI 文章地图。 */
  sourceOnly?: boolean;
  /** GitHub 仓库阅读模式只显示批注管理，不生成右侧文章地图。 */
  annotationsOnly?: boolean;
  onCopySelection?: () => void;
  onAskSelection?: () => void;
  selectedAnnotationId?: string | null;
  onAnnotationSelect?: (annotationId: string) => void;
  onAnnotationsChanged?: () => void;
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
type OutlineItem = { heading?: string; takeaway?: string; quote?: string; sourceBlockIndex?: number; anchorStatus?: 'resolved' | 'unresolved'; source?: boolean };
type Annotation = {
  id: string;
  quote: string;
  body?: string | null;
  createdAt?: string;
};
const MAP_TIMEOUT_MS = 12_000;

/** The right rail is deliberately only a document map. The article remains the primary reading surface. */
export function RadarRightPanel({
  summaryId,
  onHighlightClick,
  canInteract = false,
  annotationRefreshKey = 0,
  selectedQuote,
  onExplainSelection,
  onTranslateSelection,
  onAnnotateSelection,
  onCopySelection,
  onAskSelection,
  selectedAnnotationId,
  onAnnotationSelect,
  onAnnotationsChanged,
  rawReadingBody = '',
  contentPending = false,
  contentLoading = false,
  sourceTitle = '',
  sourceOutline: providedSourceOutline = null,
  sourceOnly = false,
  annotationsOnly = false,
  className,
}: RadarRightPanelProps) {
  const [mapState, setMapState] = useState<MapState>({ guide: null, loading: false, error: null, cached: false, coverage: null });
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isCompactViewport, setIsCompactViewport] = useState<boolean | null>(null);
  const loadingRef = useRef(false);

  const generateMap = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setMapState({ guide: null, loading: true, error: null, cached: false, coverage: null });
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), MAP_TIMEOUT_MS);
    try {
      const response = await fetch(`/api/radar/${summaryId}/transform`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'ai_reading', language: 'zh-CN' }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as {
        guide?: RadarGuide | null;
        cached?: boolean;
        message?: string;
        coverage?: Coverage;
      };
      if (!response.ok) throw new Error(body.message ?? `文章地图生成失败（HTTP ${response.status}）`);
      if (!body.guide) throw new Error(body.message ?? '文章地图暂时不可用');
      setMapState({
        guide: body.guide,
        loading: false,
        error: null,
        cached: body.cached === true,
        coverage: body.coverage ?? null,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      setMapState({
        guide: null,
        loading: false,
        error: timedOut
          ? 'AI 文章地图生成超时，已保留原文目录；不影响阅读。'
          : error instanceof Error
            ? error.message
            : '文章地图暂时不可用，已保留原文目录。',
        cached: false,
        coverage: null,
      });
    } finally {
      window.clearTimeout(timeoutId);
      loadingRef.current = false;
    }
  }, [summaryId]);

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

  useEffect(() => {
    if (selectedQuote) setMobileOpen(true);
  }, [selectedQuote]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1023px)');
    const update = () => setIsCompactViewport(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (isCompactViewport === null || sourceOnly || annotationsOnly) return;
    // 移动端地图默认折叠，不让可选的 AI 导航抢占正文首屏资源。
    if (isCompactViewport && !mobileOpen) return;
    // 等正文就绪(长度阈值 + 无 contentPending)再生成 map,避免空内容触发无意义 AI 调用
    if (rawReadingBody.trim().length < 200 || contentPending) return;
    // The map is supporting navigation, not the reading gate. Give the main
    // article a paint before starting a potentially expensive AI request.
    const timer = window.setTimeout(() => {
      void generateMap();
    }, isCompactViewport ? 0 : 700);
    return () => window.clearTimeout(timer);
  }, [annotationsOnly, contentPending, generateMap, isCompactViewport, mobileOpen, rawReadingBody, sourceOnly]);

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

  function startEditAnnotation(item: Annotation) {
    setEditingId(item.id);
    setEditingBody(item.body ?? '');
    setAnnotationError(null);
  }

  async function saveAnnotationEdit() {
    if (!editingId) return;
    const nextBody = editingBody.trim();
    setBusyId(editingId);
    setAnnotationError(null);
    try {
      const response = await fetch(`/api/radar/annotations/${editingId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: nextBody }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? '修改批注失败');
      setAnnotations((current) => current.map((item) => item.id === editingId ? { ...item, body: nextBody } : item));
      setEditingId(null);
      setEditingBody('');
      onAnnotationsChanged?.();
    } catch (error) {
      setAnnotationError(error instanceof Error ? error.message : '修改批注失败');
    } finally {
      setBusyId(null);
    }
  }

  async function deleteAnnotation(item: Annotation) {
    if (!window.confirm('确定删除这条批注吗？')) return;
    setBusyId(item.id);
    setAnnotationError(null);
    try {
      const response = await fetch(`/api/radar/annotations/${item.id}`, {
        method: 'DELETE',
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? '删除批注失败');
      setAnnotations((current) => current.filter((entry) => entry.id !== item.id));
      if (editingId === item.id) {
        setEditingId(null);
        setEditingBody('');
      }
      onAnnotationsChanged?.();
    } catch (error) {
      setAnnotationError(error instanceof Error ? error.message : '删除批注失败');
    } finally {
      setBusyId(null);
    }
  }

  const outline = mapState.guide?.outline ?? [];
  const parsedSourceOutline: OutlineItem[] = [];
  let inFence = false;
  for (const line of rawReadingBody.replace(/\r\n?/gu, '\n').split('\n')) {
    if (/^\s*(```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (!heading) continue;
    if (heading[1]!.length === 1) continue;
    const label = heading[2]!
      .replace(/[*_`]/gu, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
      .trim();
    if (!label || label === sourceTitle.trim() || parsedSourceOutline.some((item) => item.heading === label)) continue;
    parsedSourceOutline.push({
      heading: label,
      quote: label,
      anchorStatus: 'resolved',
      source: true,
    });
  }
  const sourceOutline: OutlineItem[] = parsedSourceOutline.length
    ? parsedSourceOutline
    : (providedSourceOutline ?? []).map((item) => ({
        heading: item.heading,
        source: true,
        anchorStatus: 'unresolved' as const,
      }));
  const usingSourceOutline = sourceOnly || (outline.length === 0 && sourceOutline.length > 0);
  const displayOutline = sourceOnly ? sourceOutline.slice(0, 32) : outline.length ? outline : sourceOutline.slice(0, 32);
  const annotationList = canInteract && annotations.length ? (
    <div className={annotationsOnly ? 'min-h-0 flex-1 space-y-2 lg:overflow-y-auto' : 'mt-3 space-y-2 lg:max-h-72 lg:overflow-y-auto'}>
      {annotations.map((item) => (
        <div
          key={item.id}
          className={cn(
            'break-words border-l-2 bg-[var(--ink-page)] px-3 py-2 text-xs leading-5',
            selectedAnnotationId === item.id
              ? 'border-warning-border bg-warning-bg/70'
              : 'border-[var(--ink-accent)]/60',
          )}
        >
          <button
            type="button"
            onClick={() => {
              onAnnotationSelect?.(item.id);
              onHighlightClick?.(item.quote);
            }}
            className="block w-full text-left text-[var(--ink-muted)] hover:text-[var(--ink-accent)]"
          >
            <span className="block font-serif">“{item.quote}”</span>
            {item.body ? <span className="mt-1 block text-[11px] text-[var(--ink-faint)]">{item.body}</span> : null}
          </button>
          {editingId === item.id ? (
            <div className="mt-2">
              <textarea
                value={editingBody}
                onChange={(event) => setEditingBody(event.target.value)}
                maxLength={2000}
                rows={4}
                aria-label="编辑批注内容"
                className="w-full resize-y rounded-md border border-[var(--ink-rule)] bg-[var(--ink-page)] px-2 py-1.5 text-xs leading-5 outline-none focus:border-[var(--ink-accent)]"
              />
              {annotationError ? (
                <p role="alert" className="mt-1 text-[11px] text-[var(--ink-danger-text)]">{annotationError}</p>
              ) : null}
              <div className="mt-2 flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => void saveAnnotationEdit()}
                  disabled={busyId === item.id}
                  className="inline-flex items-center gap-1 rounded-md bg-[var(--ink-accent)] px-2 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-60"
                >
                  {busyId === item.id ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(null);
                    setEditingBody('');
                    setAnnotationError(null);
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--ink-rule)] px-2 py-1 text-[11px] text-[var(--ink-muted)] hover:bg-[var(--ink-page)]"
                >
                  <X className="size-3" />
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => startEditAnnotation(item)}
                disabled={busyId === item.id}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--ink-rule)] px-2 py-1 text-[11px] text-[var(--ink-muted)] hover:bg-[var(--ink-page)] disabled:opacity-60"
              >
                <Pencil className="size-3" />编辑
              </button>
              <button
                type="button"
                onClick={() => void deleteAnnotation(item)}
                disabled={busyId === item.id}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--ink-danger-border)] px-2 py-1 text-[11px] text-[var(--ink-danger-text)] hover:bg-[var(--ink-danger)] disabled:opacity-60"
              >
                {busyId === item.id ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                删除
              </button>
              {annotationError && busyId !== item.id ? (
                <span role="alert" className="text-[11px] text-[var(--ink-danger-text)]">{annotationError}</span>
              ) : null}
            </div>
          )}
        </div>
      ))}
    </div>
  ) : null;

  if (annotationsOnly) {
    return (
      <aside className={cn('flex h-full min-h-0 flex-col', className)} aria-label="我的批注">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <p className="font-sans text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-accent)]">阅读批注</p>
            <h2 className="mt-1 font-sans text-lg font-semibold text-[var(--ink-text)]">我的批注</h2>
            <p className="mt-1 max-w-[32ch] text-xs leading-5 text-[var(--ink-muted)]">
              {annotations.length
                ? '点击批注可回到原文；可直接编辑内容或删除这条批注。'
                : '选中正文文本并保存批注后，这里会显示管理入口。'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {annotations.length ? (
              <button
                type="button"
                onClick={exportAnnotations}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--ink-accent)] hover:underline"
              >
                <Download className="size-3" />导出
              </button>
            ) : null}
            <BookmarkPlus className="mt-1 size-4 shrink-0 text-[var(--ink-accent)]" aria-hidden />
          </div>
        </div>
        {annotationList ? annotationList : (
          <div className="rounded-md border border-dashed border-[var(--ink-rule)] bg-[var(--ink-page)]/[0.6] p-4">
            <p className="font-serif text-sm leading-6 text-[var(--ink-text)]">还没有批注</p>
            <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">在正文中选中文本并保存批注后，可以在这里编辑或删除。</p>
          </div>
        )}
      </aside>
    );
  }

  const panelTitle = sourceOnly ? '来源大纲' : '文章地图';
  const panelDescription = sourceOnly
    ? '仅展示来源提供的章节结构，不生成 AI 解读。'
    : '原文是主阅读区；点击有可靠引用的条目可回到原文位置。';
  const compactPanelStatus = displayOutline.length
    ? `${displayOutline.length} 个部分`
    : contentLoading || mapState.loading
      ? '准备中'
      : mapState.error
        ? '暂不可用'
        : isCompactViewport && !mobileOpen
          ? '展开生成'
          : '查看结构';
  const panelHeader = (
    <div className="mb-5 flex items-start justify-between gap-3">
      <div>
        <p className="font-sans text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-accent)]">阅读导航</p>
        <h2 className="mt-1 font-sans text-lg font-semibold text-[var(--ink-text)]">{panelTitle}</h2>
        <p className="mt-1 max-w-[30ch] text-xs leading-5 text-[var(--ink-muted)]">{panelDescription}</p>
        {!sourceOnly && !mapState.loading && !mapState.error && mapState.guide ? (
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
  );
  const panelBody = (
    <>
      {!sourceOnly && (mapState.loading || contentLoading) ? (
        <Loading label={contentLoading ? '正在加载正文，准备文章地图' : '正在生成 AI 文章地图'} />
      ) : null}
      {!sourceOnly && mapState.error ? (
        <div role="alert" className="rounded-md border border-warning-border bg-warning-bg px-3 py-3 text-xs leading-5 text-warning-fg">
          <p>{mapState.error}</p>
          <p className="mt-1 text-warning-fg/80">下面的原文目录仍可用于定位章节。</p>
          <button type="button" onClick={() => void generateMap()} className="mt-2 block font-medium underline">重试生成</button>
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
            <button type="button" onClick={onTranslateSelection} className="inline-flex items-center gap-1 border border-warning-border px-2 py-1 text-[11px] font-medium text-warning-fg hover:bg-warning-bg">
              <Languages className="size-3" />翻译
            </button>
            {canInteract && onAskSelection ? (
              <button type="button" onClick={onAskSelection} className="inline-flex items-center gap-1 border border-method-ai/35 px-2 py-1 text-[11px] font-medium text-method-ai hover:bg-method-ai/10">
                <MessageCircle className="size-3" />问 AI
              </button>
            ) : null}
            <button type="button" onClick={onAnnotateSelection} className="inline-flex items-center gap-1 border border-[var(--ink-rule)] px-2 py-1 text-[11px] font-medium text-[var(--ink-text)] hover:bg-[var(--ink-page)]">
              <BookmarkPlus className="size-3" />批注
            </button>
            <button type="button" onClick={onCopySelection} className="inline-flex items-center gap-1 border border-[var(--ink-rule)] px-2 py-1 text-[11px] font-medium text-[var(--ink-text)] hover:bg-[var(--ink-page)]">
              <Copy className="size-3" />复制
            </button>
          </div>
        </div>
      ) : null}

      {(sourceOnly || (!mapState.loading && !contentLoading && !mapState.error)) && !displayOutline.length ? (
        <div className="rounded-md border border-dashed border-[var(--ink-rule)] bg-[var(--ink-page)]/[0.6] p-4">
          <p className="font-serif text-sm leading-6 text-[var(--ink-text)]">
            {sourceOnly ? '来源大纲暂时没有可展示的结构。' : '文章地图暂时没有可展示的结构。'}
          </p>
          <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
            {sourceOnly
              ? '来源没有提供可用目录。'
              : contentPending
                ? '正文加载完成后会自动生成；也可以直接按左侧原文阅读。'
                : 'AI 已自动尝试生成；如果文章缺少清晰章节，可直接按左侧原文阅读。'}
          </p>
        </div>
      ) : null}

      {displayOutline.length ? (
        <div className="min-h-0 flex-1 space-y-1.5 lg:overflow-y-auto">
          <p className="mb-2 text-[11px] text-[var(--ink-muted)]">
            {usingSourceOutline
              ? sourceOnly ? '来源结构' : contentPending ? '原文结构' : '原文结构 · AI 地图生成中'
              : `基于全文生成 · ${outline.length} 个部分`}
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
                  <p className="break-words font-sans text-xs font-semibold text-[var(--ink-text)]">{item.heading || `部分 ${index + 1}`}</p>
                  {item.takeaway ? <p className="mt-1 break-words font-serif text-xs leading-5 text-[var(--ink-muted)]">{item.takeaway}</p> : null}
                  {'source' in item && item.source ? (
                    <span className="mt-1 inline-flex items-center gap-0.5 text-[11px] text-[var(--ink-muted)]">
                      原文目录
                    </span>
                  ) : item.anchorStatus === 'unresolved' || !item.quote ? (
                    <span className="mt-1 block text-[11px] text-[var(--ink-faint)]">暂无精确原文位置</span>
                  ) : (
                    <span className="mt-1 inline-flex items-center gap-0.5 text-[11px] text-[var(--ink-accent)]">
                      <Crosshair className="size-3" aria-hidden />
                      回到原文
                      <span className="sr-only">(滚动到原文位置)</span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {canInteract && annotations.length ? (
        <details open className="mt-5 border-t border-[var(--ink-rule)] pt-3">
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
          {annotationList}
        </details>
      ) : null}
    </>
  );

  return (
    <aside className={cn('flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-x-clip overflow-y-visible', className)} aria-label={panelTitle}>
      <details
        className="group lg:hidden"
        open={mobileOpen}
        onToggle={(event) => setMobileOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-y border-[var(--ink-rule)] py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-accent)]/40 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0">
            <p className="font-sans text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-accent)]">阅读导航</p>
            <div className="mt-1 flex min-w-0 items-baseline gap-2">
              <span className="truncate font-sans text-sm font-semibold text-[var(--ink-text)]">{panelTitle}</span>
              <span className="shrink-0 text-[11px] text-[var(--ink-muted)]">{compactPanelStatus}</span>
            </div>
          </div>
          <ChevronDown className="size-4 shrink-0 text-[var(--ink-muted)] transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="min-w-0 max-w-full overflow-x-clip overflow-y-visible border-b border-[var(--ink-rule)] py-3">
          <p className="mb-3 text-xs leading-5 text-[var(--ink-muted)]">{panelDescription}</p>
          {panelBody}
        </div>
      </details>
      <div className="hidden min-h-0 h-full lg:flex lg:flex-col">
        {panelHeader}
        <div className="min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-x-clip overflow-y-visible">{panelBody}</div>
      </div>
    </aside>
  );
}

function Loading({ label }: { label: string }) {
  return <div className="flex items-center gap-2 rounded-md border border-[var(--ink-rule)] bg-[var(--ink-page)] px-3 py-3 text-xs text-[var(--ink-muted)]"><Loader2 className="size-3.5 animate-spin text-[var(--ink-accent)] motion-reduce:animate-none" />{label}</div>;
}
