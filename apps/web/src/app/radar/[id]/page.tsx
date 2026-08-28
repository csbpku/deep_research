'use client';

import { useParams, useSearchParams } from 'next/navigation';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpenCheck, BookmarkPlus, Check, Copy, ExternalLink, Languages, MessageCircle, Sparkles, Workflow } from 'lucide-react';
import { EmptyState } from '../../../components/EmptyState';
import { CommentSection } from '../../../components/CommentSection';
import { useCurrentUser } from '../../../lib/auth/client';
import { RadarFeedbackBar } from '../../../components/radar/RadarFeedbackBar';
import type { RadarFeedbackCounts } from '../../../components/radar/RadarFeedbackBar';
import { RadarArxivPaperCard } from '../../../components/radar/RadarArxivPaperCard';
import { RadarRepoSummary } from '../../../components/radar/RadarRepoSummary';
import { RadarZreadDocument, isZreadRepository } from '../../../components/radar/RadarZreadDocument';
import { RadarGithubItemSummary } from '../../../components/radar/RadarGithubItemSummary';
import { RadarArticleHighlights } from '../../../components/radar/RadarArticleHighlights';
import { RadarOriginalArticle } from '../../../components/radar/RadarOriginalArticle';
import { RadarRightPanel } from '../../../components/radar/RadarRightPanel';
import { ReadingProgressBar } from '../../../components/radar/ReadingProgressBar';
import { FloatingAiIcon } from '../../../components/radar/FloatingAiIcon';
import { BottomSheet } from '../../../components/radar/BottomSheet';
import { ChatPanel } from '../../../components/radar/ChatPanel';
import { SelectionActionWindow } from '../../../components/radar/SelectionActionWindow';
import { useChatSession } from '../../../components/radar/useChatSession';
import type { Anchor, ContextScope } from '../../../components/radar/useChatSession';
import type { RadarGithubItemMeta } from '../../../lib/radar/shape';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';
import { formatSourceType } from '../../../lib/radar/source-labels';
import { DistilledScorePanel } from '../../../components/radar/DistilledScorePanel';
import { Button } from '../../../components/ui/button';
import { toApiHttpError } from '../../../lib/errors/api-error';
import { retryOnceAi } from '../../../lib/errors/friendly';
import { BackToSearchButton } from '../../../components/domain/BackToSearchButton';
import {
  decodeRadarTextEntities,
  radarQuoteMatchesBlock,
} from '../../../components/radar/radar-reading-blocks';
import MarkdownContent from '../../../components/MarkdownContent';

interface RadarDetail {
  id: string;
  title: string;
  excerpt: string;
  body: string | null;
  tier: string | null;
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
  isAuthenticated: boolean;
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
  sourceOutline: Array<{ heading: string; level: number }> | null;
  topics: Array<{ id: string; slug: string; name: string; tier: string }>;
}

interface RepoMeta {
  provider?: string;
  defaultBranch?: string | null;
  language?: string | null;
  stars?: number | null;
  forks?: number | null;
  lastPushedAt?: string | null;
  description?: string | null;
  tree?: Array<{ path: string; type: 'blob' | 'tree' | 'commit'; size?: number; key?: boolean }>;
  entryPoints?: string[];
  fetchedAt?: string;
  trimmed?: boolean;
  zread?: {
    status?: 'queued' | 'generating' | 'partial' | 'complete' | 'failed';
    provider?: 'zread-cli' | 'github-readme-fallback' | string;
    commitSha?: string | null;
    generatedAt?: string | null;
    expectedPageCount?: number | null;
    error?: string | null;
    fallback?: boolean;
    pages?: Array<{
      path?: string;
      title?: string;
      content?: string;
      group?: string;
      section?: string;
      sourceRefs?: Array<{ path: string; line?: number }>;
    }>;
  } | null;
}

export default function RadarDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const returnQuery = searchParams.get('from');
  const backHref = returnQuery ? `/radar?${returnQuery}` : '/radar';
  const [chatOpen, setChatOpen] = useState(false);
  const [selectedAnchor, setSelectedAnchor] = useState<Anchor | null>(null);
  const [selectionPrompt, setSelectionPrompt] = useState<{ top: number; left: number } | null>(null);
  const [selectionWindowOrigin, setSelectionWindowOrigin] = useState({ top: 88, left: 16 });
  /* selectionAction.content 命名歧义:实际是"原文 quote"(不是 action 输出),与 selectedAnchor.quote 对齐 */
  const [selectionAction, setSelectionAction] = useState<{
    action: 'explain' | 'translate';
    originalQuote: string | null;
    loading: boolean;
    result: string | null;
    error: string | null;
  } | null>(null);
  const [selectionCopied, setSelectionCopied] = useState<'result' | 'quote' | null>(null);
  const [selectionIncomplete, setSelectionIncomplete] = useState(false);
  const [annotationRefreshKey, setAnnotationRefreshKey] = useState(0);
  const [myAnnotations, setMyAnnotations] = useState<Array<{ id: string; quote: string }>>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [annotationComposerOpen, setAnnotationComposerOpen] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState('');
  const [aiPanelWidth, setAiPanelWidth] = useState(360);
  const resizingRef = useRef(false);
  const focusTimerRef = useRef<number | null>(null);
  const leftColRef = useRef<HTMLDivElement>(null);
  const me = useCurrentUser();
  const chat = useChatSession({
    summaryId: params.id,
    enabled: chatOpen && Boolean(me.data?.id),
  });

  const selectedRangeRef = useRef<Range | null>(null);
  const lastSelectionKeyRef = useRef<string | null>(null);
  const myAnnotationsRef = useRef<Array<{ id: string; quote: string }>>([]);

  function selectionContextForScope(
    range: Range,
    quote: string,
    scope: ContextScope,
  ): string | undefined {
    if (scope === 'selection' || scope === 'full' || scope === 'project') return quote;
    const container = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const block = container?.closest<HTMLElement>('[data-radar-block="true"]');
    if (!block) return quote;
    if (scope === 'paragraph') return block.innerText.trim();
    const blocks = Array.from(leftColRef.current?.querySelectorAll<HTMLElement>('[data-radar-block="true"]') ?? []);
    const index = blocks.indexOf(block);
    const sectionStart = blocks
      .slice(0, index + 1)
      .map((item, itemIndex) => ({ item, itemIndex }))
      .reverse()
      .find(({ item }) => item.querySelector('h2, h3'));
    const sectionEnd = blocks.findIndex((item, itemIndex) => itemIndex > index && item.querySelector('h2, h3'));
    const sectionBlocks = blocks.slice(
      sectionStart?.itemIndex ?? index,
      sectionEnd >= 0 ? sectionEnd : blocks.length,
    );
    return sectionBlocks.map((item) => item.innerText.trim()).filter(Boolean).join('\n\n');
  }

  function withSelectionContext(anchor: Anchor | null | undefined, scope: ContextScope): Anchor | null | undefined {
    if (!anchor?.quote || scope === 'selection' || scope === 'full' || scope === 'project') return anchor;
    if (anchor.contextByScope?.[scope]?.trim()) return anchor;
    const range = selectedRangeRef.current;
    if (!range) return anchor;
    const context = selectionContextForScope(range, anchor.quote, scope);
    return context
      ? { ...anchor, contextByScope: { ...anchor.contextByScope, [scope]: context } }
      : anchor;
  }
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
    // Radar enrichment can update originalMarkdown while this SPA session is
    // still alive. Always refetch when returning to a detail page so a stale
    // client-side snapshot cannot mask the newly normalized source content.
    refetchOnMount: 'always',
  });

  const refreshZreadDocument = useCallback(async () => {
    const summaryId = q.data?.id;
    if (!summaryId) return;
    const response = await fetch(`/api/radar/${summaryId}/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const payload = await response.json().catch(() => ({})) as { message?: string };
    if (!response.ok) throw new Error(payload.message ?? '项目文档刷新失败');
    const originalMeta = q.data?.originalMeta;
    const previousGeneratedAt = originalMeta
      && typeof originalMeta === 'object'
      && !Array.isArray(originalMeta)
      ? (originalMeta as RepoMeta).zread?.generatedAt ?? null
      : null;
    for (let attempt = 0; attempt < 45; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      const next = await q.refetch();
      const generatedAt = next.data?.originalMeta
        && typeof next.data.originalMeta === 'object'
        && !Array.isArray(next.data.originalMeta)
        && (next.data.originalMeta as RepoMeta).zread?.generatedAt;
      if (generatedAt && generatedAt !== previousGeneratedAt) return;
    }
  }, [q.data?.id, q.data?.originalMeta, q.refetch]);

  const retryZreadDocument = useCallback(async () => {
    const summaryId = q.data?.id;
    if (!summaryId) return;
    await fetch(`/api/radar/${summaryId}/migrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    await q.refetch();
  }, [q.data?.id, q.refetch]);

  const findRadarBlock = useCallback((quote: string, sourceBlockIndex?: number, anchorId?: string): HTMLElement | null => {
    const leftCol = leftColRef.current;
    if (!leftCol || !quote.trim()) return null;
    if (anchorId) {
      const anchored = document.getElementById(anchorId)?.closest<HTMLElement>('[data-radar-block="true"]');
      if (anchored && leftCol.contains(anchored) && radarQuoteMatchesBlock(anchored.textContent ?? '', quote)) return anchored;
    }
    const blocks = Array.from(leftCol.querySelectorAll<HTMLElement>('[data-radar-block="true"]'));
    if (sourceBlockIndex != null) {
      const indexed = blocks.find((block) => Number(block.dataset.radarBlockIndex) === sourceBlockIndex);
      if (indexed && radarQuoteMatchesBlock(indexed.textContent ?? '', quote)) return indexed;
    }
    // Never choose a merely similar paragraph. If the AI quote cannot be
    // proven to belong to one block, returning null is the safe behavior.
    return blocks.find((block) => radarQuoteMatchesBlock(block.textContent ?? '', quote)) ?? null;
  }, []);

  const focusRadarBlock = useCallback((
    quote: string | null,
    scroll = false,
    sourceBlockIndex?: number,
    anchorId?: string,
  ) => {
    const leftCol = leftColRef.current;
    if (!leftCol) return;
    leftCol.querySelectorAll<HTMLElement>('[data-radar-block="true"].radar-source-focus').forEach((block) => block.classList.remove('radar-source-focus'));
    if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current);
    if (!quote) return;
    const target = findRadarBlock(quote, sourceBlockIndex, anchorId);
    if (!target) return;
    target.classList.add('radar-source-focus');
    if (scroll) {
      const targetRect = target.getBoundingClientRect();
      const containerRect = leftCol.getBoundingClientRect();
      const nextTop = leftCol.scrollTop + targetRect.top - containerRect.top - (leftCol.clientHeight - targetRect.height) / 2;
      leftCol.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
    }
    focusTimerRef.current = window.setTimeout(() => target.classList.remove('radar-source-focus'), scroll ? 3200 : 1200);
  }, [findRadarBlock]);

  const handleHighlightClick = useCallback((quote: string, sourceBlockIndex?: number, anchorId?: string) => {
    focusRadarBlock(quote, true, sourceBlockIndex, anchorId);
  }, [focusRadarBlock]);

  const handleAnnotationSelect = useCallback((annotationId: string) => {
    const annotation = myAnnotationsRef.current.find((item) => item.id === annotationId);
    if (!annotation) {
      setSelectedAnnotationId(null);
      return;
    }
    focusRadarBlock(annotation.quote, true);
    setSelectedAnnotationId(annotationId);
  }, [focusRadarBlock]);

  const handleAnnotationsChanged = useCallback(() => {
    setAnnotationRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    const summaryId = q.data?.id;
    if (!summaryId) return;
    const root = leftColRef.current;
    if (!root) return;
    const storageKey = `radar-reading-position:${summaryId}`;
    const saved = Number(window.localStorage.getItem(storageKey) ?? 0);
    if (Number.isFinite(saved) && saved > 0) {
      requestAnimationFrame(() => {
        root.scrollTop = saved;
      });
    }
    let timer: number | null = null;
    const persist = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        window.localStorage.setItem(storageKey, String(Math.round(root.scrollTop)));
      }, 180);
    };
    root.addEventListener('scroll', persist, { passive: true });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      root.removeEventListener('scroll', persist);
    };
  }, [q.data?.id, q.data?.originalMarkdown, q.data?.body]);

  useEffect(() => {
    if (!q.data?.id || !me.data?.id) {
      setMyAnnotations([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/radar/annotations?summaryId=${encodeURIComponent(q.data.id)}&mine=true`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ annotations?: Array<{ id: string; quote: string }> }>;
      })
      .then((body) => {
        if (!cancelled) setMyAnnotations(body?.annotations ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [annotationRefreshKey, me.data?.id, q.data?.id]);

  useEffect(() => {
    setSelectedAnnotationId(null);
  }, [q.data?.id]);

  useEffect(() => {
    myAnnotationsRef.current = myAnnotations;
  }, [myAnnotations]);

  // 访问即触发渐进迁移：只投递缺正文/旧 enrichment 的条目，实际抓取、
  // 重新生成和评分由 ai-engine 后台完成，不阻塞正文首屏。
  useEffect(() => {
    if (!q.data?.id) return;
    void fetch(`/api/radar/${q.data.id}/migrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }).catch(() => undefined);
  }, [q.data?.id]);

  useEffect(() => {
    let selectionTimer: number | null = null;

    const clearSelectionUi = () => {
      lastSelectionKeyRef.current = null;
      selectedRangeRef.current = null;
      setSelectionPrompt(null);
      setSelectedAnchor(null);
      setSelectionAction(null);
      setAnnotationComposerOpen(false);
    };

    const processSelection = (eventTarget?: EventTarget | null) => {
      const target = eventTarget instanceof Element
        ? eventTarget
        : eventTarget instanceof Node
          ? eventTarget.parentElement
          : null;
      if (target?.closest('[data-selection-ui="true"]')) return;
      const selection = window.getSelection();
      const anchorNode = selection?.anchorNode;
      const readingBody = anchorNode instanceof Element
        ? anchorNode.closest('[data-radar-reading-body="true"]')
        : anchorNode?.parentElement?.closest('[data-radar-reading-body="true"]');
      if (!readingBody) {
        clearSelectionUi();
        return;
      }
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
        clearSelectionUi();
        return;
      }
      const range = selection.getRangeAt(0);
      if (!readingBody.contains(range.commonAncestorContainer)) {
        clearSelectionUi();
        return;
      }
      const quote = selection.toString().trim().slice(0, 12000);
      const selectionKey = `${quote}:${range.startContainer.textContent?.slice(0, 32) ?? ''}:${range.startOffset}:${range.endOffset}`;
      if (lastSelectionKeyRef.current === selectionKey) return;
      lastSelectionKeyRef.current = selectionKey;
      const rect = range.getBoundingClientRect();
      const promptTop = rect.bottom + 10 <= window.innerHeight - 54
        ? rect.bottom + 10
        : Math.max(12, rect.top - 54);
      const promptLeft = Math.min(
        Math.max(12, rect.left + rect.width / 2 - 120),
        Math.max(12, window.innerWidth - 252),
      );
      selectedRangeRef.current = range.cloneRange();
      setSelectedAnchor({ quote, startOffset: 0, endOffset: quote.length, contextByScope: { selection: quote } });
      chat.setContextScope('selection');
      setSelectionAction(null);
      setSelectionWindowOrigin({
        top: rect.bottom + 382 <= window.innerHeight ? rect.bottom + 12 : Math.max(12, rect.top - 372),
        left: Math.min(Math.max(12, rect.left + rect.width / 2 - 250), Math.max(12, window.innerWidth - 512)),
      });
      setSelectionPrompt({ top: promptTop, left: promptLeft });
    };
    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      processSelection(event.target);
    };
    const handleSelectionChange = () => {
      const active = document.activeElement;
      if (active instanceof Element && active.closest('[data-selection-ui="true"]')) {
        if (selectionTimer !== null) {
          window.clearTimeout(selectionTimer);
          selectionTimer = null;
        }
        return;
      }
      // selectionchange 在拖选/右键时高频触发，合并到选区稳定后再更新一次，
      // 避免 Zread 等长正文因为每次事件都重渲染而卡顿。
      if (selectionTimer !== null) window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(() => {
        selectionTimer = null;
        processSelection();
      }, 120);
    };
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      if (selectionTimer !== null) window.clearTimeout(selectionTimer);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!resizingRef.current) return;
      const nextWidth = Math.min(520, Math.max(280, window.innerWidth - event.clientX));
      setAiPanelWidth(nextWidth);
    };
    const stopResizing = () => {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResizing);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResizing);
    };
  }, []);

  const startPanelResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handlePanelResizeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowLeft') setAiPanelWidth((width) => Math.min(520, width + 16));
    if (event.key === 'ArrowRight') setAiPanelWidth((width) => Math.max(280, width - 16));
  };

  if (q.isLoading) {
    return (
      <div className="mx-auto max-w-measure">
        <div className="flex items-center gap-2">
          <BackToSearchButton />
          <Link href={backHref} className="text-sm text-muted-foreground hover:text-primary">← 返回雷达</Link>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">加载中…</p>
      </div>
    );
  }
  if (q.isError) {
    const errorMessage = String((q.error as Error).message);
    const needsLogin = errorMessage.includes('登录') || errorMessage.includes('授权');
    return (
      <div className="mx-auto max-w-measure">
        <div className="flex items-center gap-2">
          <BackToSearchButton />
          <Link href={backHref} className="text-sm text-muted-foreground hover:text-primary">← 返回雷达</Link>
        </div>
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
  const displayTitle = decodeRadarTextEntities(d.title);
  const sourceLabel = formatSourceType(d.sourceType);
  const tier = d.tier ?? d.distilledScore?.tier ?? null;
  const isFullReading = tier === 'collection' || tier === 'deep_read';
  const isSkim = tier === 'skim';
  const repoReader = isFullReading && d.originalKind === 'github_repo' && isZreadRepository(d.url);
  const repoMeta = repoReader ? (d.originalMeta ?? null) as RepoMeta | null : null;
  const arxivMeta = d.originalKind === 'arxiv'
    && d.originalMeta
    && typeof d.originalMeta === 'object'
    && !Array.isArray(d.originalMeta)
    ? d.originalMeta as { arxivId?: string; keyContributions?: string[]; sectionCount?: number }
    : null;
  const repoPages = repoMeta?.zread?.pages?.filter((page) => page.content?.trim()) ?? [];
  const repoReadingBody = repoPages.map((page) => page.content?.trim()).filter(Boolean).join('\n\n');
  const rawReadingBody = isFullReading
    ? repoReader ? repoReadingBody : d.originalMarkdown ?? d.body ?? ''
    : '';
  const repoCoverageComplete = repoReader
    && repoMeta?.zread?.status === 'complete'
    && repoMeta?.zread?.provider !== 'github-readme-fallback';
  const contentPending = isFullReading && (repoReader
    ? repoPages.length === 0
    : d.tags.includes('content_pending') || rawReadingBody.trim().length < 200);
  const readingBody = isFullReading
    ? contentPending
      ? d.interpretation ?? d.highlights?.summary ?? d.excerpt
      : repoReader
        ? repoReadingBody
        : d.originalMarkdown ?? d.body ?? d.highlights?.summary ?? d.interpretation ?? d.excerpt
    : isSkim
      ? d.interpretation ?? d.excerpt
    : '';
  const canInteract = Boolean(me.data?.id);
  const repoBrief = d.originalKind === 'github_repo' ? d.interpretation?.trim() || null : null;
  const repoProjectSummary = d.originalKind === 'github_repo' ? d.repoSummary?.trim() || null : null;
  const hasRepoText = Boolean(repoBrief || repoProjectSummary);
  const hasDedicatedKindBadge = d.originalKind === 'arxiv' || d.originalKind?.startsWith('github');
  const originalKindLabel = d.originalKind === 'arxiv'
    ? 'arXiv 论文'
    : d.originalKind === 'github_repo'
      ? 'GitHub 仓库'
      : d.originalKind === 'github_release'
        ? 'GitHub 发布'
        : d.originalKind === 'github_other'
          ? 'GitHub 动态'
          : null;
  const arxivAuthorsLabel = d.authors.length > 3
    ? `${d.authors.slice(0, 3).join(', ')} 等 ${d.authors.length} 人`
    : d.authors.join(', ');
  // Zread already provides a complete project-document TOC in the reading
  // column. Articles and papers keep the AI map alongside the deterministic
  // source TOC so the user can compare structure with interpretation.
  const showRightPanel = repoReader ? canInteract && myAnnotations.length > 0 : true;
  const repoContextLabel = repoReader
    ? repoPages.length > 0
      ? `${repoMeta?.zread?.provider === 'github-readme-fallback' ? 'GitHub README' : 'Zread 项目文档'} · ${
        repoMeta?.zread?.expectedPageCount
          ? `${repoPages.length}/${repoMeta.zread.expectedPageCount} 页`
          : `${repoPages.length} 页`
      } · commit ${(repoMeta?.zread?.commitSha ?? repoMeta?.defaultBranch ?? '—').slice(0, 8)}`
      : repoMeta?.zread?.status === 'failed'
        ? '项目文档抓取失败'
        : repoMeta?.zread?.status === 'generating'
          ? '项目文档抓取中'
          : '项目文档尚未抓取'
    : undefined;

  async function runSelectionAction(action: 'explain' | 'translate') {
    const quote = selectedAnchor?.quote?.trim();
    if (!quote) return;
    const contextualAnchor = withSelectionContext(selectedAnchor, chat.contextScope);
    const actionContent = action === 'translate' && chat.contextScope !== 'full' && chat.contextScope !== 'project'
      ? contextualAnchor?.contextByScope?.[chat.contextScope]?.trim() || quote
      : quote;
    setSelectionCopied(null);
    setSelectionIncomplete(false);
    setSelectionPrompt(null);
    setSelectionAction({ action, originalQuote: quote, loading: true, result: null, error: null });
    try {
      const mode = action === 'translate' ? 'translate' : 'ai_reading';
      const response = await fetch(`/api/radar/${params.id}/transform`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, language: 'zh-CN', selection: actionContent }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        content?: string;
        guide?: { summary?: string; keyTakeaways?: Array<{ claim?: string }> } | null;
        chunks?: Array<{ content?: string }>;
        complete?: boolean;
        failedChunkIndexes?: number[];
        truncatedChunkIndexes?: number[];
        message?: string;
      };
      const result = action === 'translate'
        ? body.chunks?.map((chunk) => chunk.content?.trim()).filter(Boolean).join('\n\n')
        : body.content;
      if (!response.ok || !result) throw new Error(body.message ?? '暂时没有可用的结果');
      setSelectionIncomplete(
        body.complete === false
        || Boolean(body.failedChunkIndexes?.length)
        || Boolean(body.truncatedChunkIndexes?.length),
      );
      setSelectionAction({ action, originalQuote: quote, loading: false, result, error: null });
    } catch (error) {
      setSelectionAction({ action, originalQuote: quote, loading: false, result: null, error: error instanceof Error ? error.message : '操作暂时不可用' });
    }
  }

  async function copySelectionResult() {
    const result = selectionAction?.result?.trim();
    if (!result || !navigator.clipboard) return;
    await navigator.clipboard.writeText(result);
    setSelectionCopied('result');
    window.setTimeout(() => setSelectionCopied(null), 1800);
  }

  async function copySelectedQuote() {
    const quote = selectedAnchor?.quote?.trim();
    if (!quote || !navigator.clipboard) return;
    await navigator.clipboard.writeText(`> ${quote.replace(/\n/gu, '\n> ')}`);
    setSelectionCopied('quote');
    window.setTimeout(() => setSelectionCopied(null), 1800);
  }

  async function saveSelectedAnnotation(note = annotationDraft) {
    const anchor = selectedAnchor;
    const quote = anchor?.quote?.trim();
    if (!anchor || !quote) return;
    if (!canInteract) {
      setSelectionAction({
        action: 'explain',
        originalQuote: quote,
        loading: false,
        result: null,
        error: '请先登录，再保存正文批注。',
      });
      setAnnotationComposerOpen(true);
      return;
    }
    try {
      const response = await fetch('/api/radar/annotations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          summaryId: d.id,
          kind: 'highlight',
          quote,
          startOffset: anchor.startOffset,
          endOffset: anchor.endOffset,
          body: note.trim() || undefined,
        }),
      });
      const saved = (await response.json().catch(() => ({}))) as {
        id?: string;
        message?: string;
        error?: { message?: string };
      };
      const savedId = saved.id;
      if (!response.ok || !savedId) {
        throw new Error(saved.message ?? saved.error?.message ?? `保存高亮失败（HTTP ${response.status}）`);
      }
      setMyAnnotations((current) => current.some((item) => item.id === savedId)
        ? current
        : [...current, { id: savedId, quote }]);
      setSelectionAction({
        action: 'explain',
        originalQuote: quote,
        loading: false,
        result: note.trim() ? '已保存原文引用和结果到你的阅读批注。' : '已保存原文引用到你的阅读批注。',
        error: null,
      });
      setAnnotationRefreshKey((value) => value + 1);
      setAnnotationComposerOpen(false);
      setAnnotationDraft('');
    } catch (error) {
      setSelectionAction({
        action: 'explain',
        originalQuote: quote,
        loading: false,
        result: null,
        error: error instanceof Error ? error.message : '保存批注失败',
      });
    }
  }

  async function saveSelectionExplanation() {
    const result = selectionAction?.result?.trim();
    if (!result || !selectedAnchor?.quote) return;
    await saveSelectedAnnotation(result);
  }

  function openAnnotationComposer() {
    if (!selectedAnchor?.quote) return;
    setSelectionAction({
      action: 'explain',
      originalQuote: selectedAnchor.quote,
      loading: false,
      result: null,
      error: null,
    });
    setSelectionPrompt(null);
    setAnnotationComposerOpen(true);
  }

  function handleChatSubmit(content: string, anchor?: Anchor | null) {
    void chat.sendMessage(content, withSelectionContext(anchor, chat.contextScope));
  }

  function renderSelectionPopover() {
    if (!selectedAnchor) return null;
    if (selectionAction?.originalQuote === selectedAnchor.quote) {
      const title = annotationComposerOpen
        ? '添加批注'
        : selectionAction.action === 'explain'
          ? '解释选中内容'
          : '翻译选中内容';
      const footer = (
        <>
          {!annotationComposerOpen && selectionAction.result ? (
            <button type="button" onClick={() => void copySelectionResult()} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-foreground hover:bg-muted">
              {selectionCopied === 'result' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {selectionCopied === 'result' ? '已复制' : selectionAction.action === 'translate' ? '复制译文' : '复制解释'}
            </button>
          ) : null}
          {!annotationComposerOpen && selectionAction.result ? (
            <button
              type="button"
              onClick={() => void saveSelectionExplanation()}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-foreground hover:bg-muted"
              aria-label="把原文引用和结果保存到批注"
            >
              <BookmarkPlus className="size-3.5" />保存结果到批注
            </button>
          ) : null}
          <button type="button" onClick={() => void copySelectedQuote()} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-foreground hover:bg-muted">
            {selectionCopied === 'quote' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {selectionCopied === 'quote' ? '已复制' : '复制原文引用'}
          </button>
        </>
      );
      return (
        <SelectionActionWindow
          title={title}
          initialPosition={selectionWindowOrigin}
          placementKey={`${selectedAnchor.quote}:${selectionAction.action}:${annotationComposerOpen ? 'annotation' : 'result'}`}
          onClose={() => {
            setSelectionAction(null);
            setAnnotationComposerOpen(false);
          }}
          footer={footer}
        >
          {annotationComposerOpen ? (
            <div>
              <label className="block text-xs font-medium text-foreground" htmlFor="radar-annotation-note">对这段文字添加批注</label>
              {selectionAction.error ? (
                <p role="alert" className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  {selectionAction.error}
                </p>
              ) : null}
              <textarea
                id="radar-annotation-note"
                value={annotationDraft}
                onChange={(event) => setAnnotationDraft(event.target.value)}
                maxLength={2000}
                rows={6}
                placeholder="写下你的理解、疑问或后续线索（可选）"
                className="mt-2 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAnnotationComposerOpen(false);
                    setSelectionAction(null);
                  }}
                  className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                >
                  取消
                </button>
                <button type="button" onClick={() => void saveSelectedAnnotation()} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90">保存批注</button>
              </div>
            </div>
          ) : (
            <>
              {selectionAction.loading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Sparkles className="size-4 animate-pulse text-method-ai" />
                  {selectionAction.action === 'translate' ? '正在翻译…' : '正在解释…'}
                </div>
              ) : null}
              {selectionAction.error ? <div className="text-sm text-destructive">{selectionAction.error}</div> : null}
              {selectionIncomplete ? (
                <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  当前结果不完整，部分内容生成失败或被截断。
                </div>
              ) : null}
              {selectionAction.result ? (
                <MarkdownContent
                  content={selectionAction.result}
                  compact
                  className="text-sm leading-7"
                />
              ) : null}
            </>
          )}
        </SelectionActionWindow>
      );
    }
    if (!selectionPrompt) return null;
    const translationLabel = chat.contextScope === 'paragraph'
      ? '翻译段落'
      : chat.contextScope === 'section'
        ? '翻译章节'
        : '翻译';
    const translationScopeLabel = chat.contextScope === 'paragraph'
      ? '段落'
      : chat.contextScope === 'section'
        ? '章节'
        : null;
    return (
      <div
        data-selection-ui="true"
        className="fixed z-[9980]"
        style={selectionPrompt}
        onMouseDown={(event) => event.stopPropagation()}
        onMouseUp={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-1 rounded-xl border border-border bg-background/95 p-1.5 shadow-xl backdrop-blur">
          {/* 选区操作按钮:触控目标 ≥ 44×44,带 aria-label + 当前 scope 上下文 */}
          <Button
            type="button"
            size="sm"
            onClick={() => void runSelectionAction('explain')}
            disabled={selectionAction?.loading === true}
            aria-label="解释选中内容"
          >
            <Sparkles className="size-3.5" />解释
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void runSelectionAction('translate')}
            disabled={selectionAction?.loading === true}
            aria-label={`${translationLabel}(范围:${translationScopeLabel})`}
          >
            <Languages className="size-3.5" />
            <span>
              {translationLabel}
            </span>
            {translationScopeLabel ? (
              <span className="ml-1 rounded bg-amber-200/60 px-1 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                {translationScopeLabel}
              </span>
            ) : null}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setChatOpen(true);
              setSelectionPrompt(null);
            }}
            aria-label="对选区发起 AI 问答"
          >
            <MessageCircle className="size-3.5" />问 AI
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={openAnnotationComposer}
            aria-label="将原文保存到批注"
          >
            <BookmarkPlus className="size-3.5" />批注
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-104px)] flex-col">
      {/* 顶栏：返回 + 来源 badge + 阅读进度条 */}
      <div className="relative flex items-center justify-between border-b border-border bg-background px-4 py-3">
        <div className="flex items-center gap-2">
          <BackToSearchButton />
          <Link href={backHref} className="text-sm text-muted-foreground hover:text-primary">← 回到雷达列表</Link>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {!hasDedicatedKindBadge ? (
            <span
              className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground"
              aria-label={sourceLabel.full}
              title={sourceLabel.full}
            >
              {sourceLabel.short}
            </span>
          ) : null}
          {originalKindLabel ? (
            <span
              data-testid="original-kind-badge"
              className="rounded-full border border-primary/30 bg-accent px-2 py-0.5 text-[11px] text-accent-foreground"
            >
              {originalKindLabel}
            </span>
          ) : null}
          <a
            href={d.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-primary/35 bg-primary/5 px-2.5 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <ExternalLink className="size-3.5" />
            {repoReader ? '打开 GitHub' : '打开原文'}
          </a>
        </div>
        <ReadingProgressBar scrollRef={leftColRef} />
      </div>

      {renderSelectionPopover()}

      {/* 原文主阅读区 + 上下文工具栏。右侧不再渲染第二份正文。 */}
      <div
        className={showRightPanel
          ? 'flex min-h-0 flex-1 flex-col overflow-y-auto contain-layout contain-paint lg:grid lg:overflow-hidden'
          : 'flex min-h-0 flex-1 flex-col overflow-y-auto contain-layout contain-paint'}
        style={showRightPanel ? { gridTemplateColumns: `minmax(0, 1fr) 12px ${aiPanelWidth}px` } : undefined}
      >
        <div ref={leftColRef} className="min-w-0 border-r border-border bg-[var(--ink-page)] px-8 py-8 lg:min-h-0 lg:overflow-y-auto">
          <article className="mx-auto w-full max-w-[96rem] leading-7">
            <h1 className={`font-serif text-3xl font-semibold leading-tight tracking-normal ${
              isFullReading && d.originalKind === 'arxiv' ? 'mb-2' : 'mb-6'
            }`}>{displayTitle}</h1>
            {isFullReading && d.originalKind === 'arxiv' && (arxivAuthorsLabel || arxivMeta?.arxivId) ? (
              <p className="mb-5 text-xs leading-5 text-muted-foreground">
                {arxivAuthorsLabel}
                {arxivAuthorsLabel && arxivMeta?.arxivId ? ' · ' : null}
                {arxivMeta?.arxivId ? <span className="font-mono">arXiv:{arxivMeta.arxivId}</span> : null}
              </p>
            ) : null}

            {!repoReader && contentPending ? (
              <div className="mb-7 flex items-start gap-2 rounded-md border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning-fg">
                <div className="flex-1">
                  <strong>正文正在补抓</strong>
                  <span className="ml-2">当前仅展示来源摘要，未使用不完整正文参与评分；访问后会在后台重新抓取并生成。</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const el = document.getElementById('enrichment-banner');
                    if (el) el.style.display = 'none';
                  }}
                  aria-label="关闭正文补抓提示"
                  className="shrink-0 rounded p-1 text-warning-fg hover:bg-warning-fg/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  ×
                </button>
              </div>
            ) : null}
            <div data-testid="reading-coverage" className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span className={isSkim || (repoReader ? repoCoverageComplete : !contentPending)
                ? 'font-medium text-status-succeeded-fg'
                : 'font-medium text-status-partial-fg'}>
                正文覆盖：{isSkim
                  ? '摘要 + 来源大纲'
                  : repoReader
                  ? repoCoverageComplete
                    ? '完整项目文档'
                    : repoPages.length
                      ? '部分项目文档'
                      : '暂无项目文档'
                  : contentPending
                    ? '不完整'
                    : '已抓取'}
              </span>
              {repoReader && repoPages.length ? (
                <span>
                  文档页：{repoMeta?.zread?.expectedPageCount
                    ? `${repoPages.length}/${repoMeta.zread.expectedPageCount}`
                    : repoPages.length}
                </span>
              ) : null}
              {(repoReader ? !repoCoverageComplete : contentPending) ? (
                <span>{repoReader ? 'AI 结论不代表完整项目' : 'AI 结论不代表全文'}</span>
              ) : null}
            </div>

            {d.selectionReason ? (
              <p className="mb-7 rounded-md border-l-2 border-status-succeeded-fg bg-status-succeeded-bg px-3 py-2 text-sm text-status-succeeded-fg">
                <strong>入选理由：</strong>
                {d.selectionReason}
                {d.sortOrder !== null ? `（#${d.sortOrder}）` : ''}
              </p>
            ) : null}

            {d.topics.length ? <RadarTopicPicker topics={d.topics} /> : null}

            {d.distilledScore || d.scoreReason || (d.interpretation && d.originalKind !== 'github_repo') || (d.originalKind === 'github_repo' && !repoReader && hasRepoText) || d.originalKind === 'arxiv' || d.githubItemMeta || d.highlights ? (
              <details className="mb-7 rounded-xl border border-border bg-card group">
                <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [&::-webkit-details-marker]:hidden">
                  <span className="mr-2 text-xs text-muted-foreground">按需查看</span>
                  来源分析、评分与结构
                  <span className="float-right text-muted-foreground transition-transform group-open:rotate-180">⌄</span>
                </summary>
                <div className="border-t border-border px-4 py-4">
                  {d.distilledScore ? (
                    <div className="mb-6">
                      <DistilledScorePanel score={d.distilledScore} />
                    </div>
                  ) : d.scoreReason ? (
                    <p className="mb-6 text-sm text-muted-foreground">
                      <strong>评分理由：</strong>
                      {d.scoreReason}
                    </p>
                  ) : null}

                  {d.interpretation && d.originalKind !== 'github_repo' ? (
                    <p className="mb-6 rounded-md border-l-2 border-primary bg-accent/60 px-4 py-3 text-sm leading-7 text-foreground">
                      <span className="mr-1.5 text-xs font-medium text-muted-foreground">AI 一句话解读：</span>
                      {d.interpretation}
                    </p>
                  ) : null}

                  {d.originalKind === 'github_repo' && !repoReader && hasRepoText ? (
                    <RadarRepoSummary
                      brief={repoBrief}
                      summary={repoProjectSummary}
                      meta={(d.originalMeta ?? null) as RepoMeta | null}
                    />
                  ) : null}

                  {d.originalKind === 'arxiv' ? (
                    <RadarArxivPaperCard
                      meta={arxivMeta ?? {}}
                      authors={d.authors}
                      tldr={d.tldr}
                      analysis={d.arxivAnalysis}
                    />
                  ) : null}

                  {(d.originalKind === 'github_other' || d.originalKind === 'github_release') && d.githubItemMeta ? (
                    <RadarGithubItemSummary meta={d.githubItemMeta} />
                  ) : null}

                  {(d.originalKind === 'rss' || d.originalKind === 'web_share') && d.highlights ? (
                    <div>
                      <p className="mb-2 text-xs font-semibold text-muted-foreground">来源摘要与亮点</p>
                      <RadarArticleHighlights {...d.highlights} />
                    </div>
                  ) : null}
                </div>
              </details>
            ) : null}

            {repoReader ? (
              <RadarZreadDocument
                repositoryUrl={d.url}
                leftColRef={leftColRef}
                meta={repoMeta}
                aiBrief={repoBrief}
                projectSummary={repoProjectSummary}
                annotations={myAnnotations}
                selectedAnnotationId={selectedAnnotationId}
                onAnnotationClick={handleAnnotationSelect}
                onRefresh={refreshZreadDocument}
                onRetry={retryZreadDocument}
              />
            ) : readingBody && readingBody !== d.interpretation ? (
              <RadarOriginalArticle
                content={readingBody}
                title={displayTitle}
                paperMode={d.originalKind === 'arxiv'}
                highlights={d.highlights}
                annotations={myAnnotations}
                selectedAnnotationId={selectedAnnotationId}
                onAnnotationClick={handleAnnotationSelect}
              />
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
                    <span key={t} className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
                      #{t}
                    </span>
                  ))}
                </div>
              );
            })()}

            {canInteract ? (
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
            ) : (
              <p className="mt-6 border-y border-border py-3 text-xs text-muted-foreground">
                <Link href="/signin" className="font-medium text-primary hover:underline">登录</Link>
                {' '}后可收藏、反馈、评论和继续调研。
              </p>
            )}

            <div id="discussion" className="scroll-mt-20">
              {canInteract ? (
                <CommentSection
                  targetType="summary"
                  targetId={d.id}
                  currentUserId={me.data?.id ?? null}
                  currentUserRole={me.data?.role ?? null}
                  content={readingBody}
                />
              ) : (
                <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
                  登录后参与团队讨论。
                </div>
              )}
            </div>
          </article>
        </div>

        {showRightPanel ? (
          <>
            <button
              type="button"
              className="group hidden w-3 touch-none cursor-col-resize items-center justify-center border-x border-border bg-[var(--ink-page)] hover:bg-muted focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 lg:flex"
              aria-label="调整右侧 AI 栏宽度"
              aria-valuemin={280}
              aria-valuemax={520}
              aria-valuenow={aiPanelWidth}
              role="separator"
              onPointerDown={startPanelResize}
              onKeyDown={handlePanelResizeKeyDown}
            >
              <span className="h-12 w-0.5 rounded-full bg-border transition-colors group-hover:bg-primary" />
            </button>
            <div className="min-h-[360px] min-w-0 shrink-0 bg-[var(--ink-page)] px-6 py-8 lg:min-h-0 lg:overflow-y-auto">
              <RadarRightPanel
                summaryId={d.id}
                onHighlightClick={handleHighlightClick}
                canInteract={canInteract}
                rawReadingBody={rawReadingBody}
                contentPending={contentPending || isSkim}
                sourceTitle={displayTitle}
                sourceOutline={d.sourceOutline}
                sourceOnly={isSkim}
                annotationsOnly={repoReader}
                annotationRefreshKey={annotationRefreshKey}
                selectedQuote={selectedAnchor?.quote ?? null}
                onExplainSelection={() => void runSelectionAction('explain')}
                onTranslateSelection={() => void runSelectionAction('translate')}
                onAnnotateSelection={openAnnotationComposer}
                onCopySelection={() => void copySelectedQuote()}
                onAskSelection={() => {
                  setChatOpen(true);
                  setSelectionPrompt(null);
                }}
                selectedAnnotationId={selectedAnnotationId}
                onAnnotationSelect={handleAnnotationSelect}
                onAnnotationsChanged={handleAnnotationsChanged}
              />
            </div>
          </>
        ) : null}
      </div>

      {canInteract ? (
        <>
          <FloatingAiIcon isOpen={chatOpen} onClick={() => setChatOpen((v) => !v)} />
          <BottomSheet
            open={chatOpen}
            onOpenChange={setChatOpen}
            title="与 AI 讨论"
            subtitle={displayTitle}
          >
            <ChatPanel
              messages={chat.session?.messages ?? []}
              loading={chat.loading}
              sending={chat.sending}
              slowGeneration={chat.slowGeneration}
              thinkingStep={chat.thinkingStep}
              err={chat.err}
              input={chat.input}
              onInputChange={chat.setInput}
              onSubmit={handleChatSubmit}
              onStop={chat.stopGeneration}
              onRetryLoad={chat.retryLoad}
              messagesRef={chat.messagesRef}
              textareaRef={chat.textareaRef}
              compact
              contextLabel={repoContextLabel}
              selectedAnchor={selectedAnchor}
              onClearSelectedAnchor={() => {
                selectedRangeRef.current = null;
                setSelectedAnchor(null);
                chat.setContextScope('full');
              }}
              contextScope={chat.contextScope}
              onContextScopeChange={chat.setContextScope}
              hasProjectContext={repoReader}
              onSourceClick={handleHighlightClick}
            />
          </BottomSheet>
        </>
      ) : null}
    </div>
  );
}

function RadarTopicPicker({
  topics,
}: {
  topics: Array<{ id: string; slug: string; name: string; tier: string }>;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 text-xs">
      <span className="font-medium text-muted-foreground">关联专题</span>
      {topics.map((topic) => (
        <Link key={topic.id} href={`/topics/${topic.slug}`} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-muted-foreground hover:border-primary/40 hover:text-primary">
          <BookOpenCheck className="size-3" />{topic.name}
        </Link>
      ))}
      {topics.length === 0 ? <span className="text-muted-foreground">等待系统自动归类</span> : null}
    </div>
  );
}
