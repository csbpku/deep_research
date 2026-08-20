'use client';

import { useParams, useSearchParams } from 'next/navigation';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { BookOpenCheck, BookmarkPlus, Check, Copy, ExternalLink, Languages, MessageCircle, Plus, Sparkles, Workflow } from 'lucide-react';
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
import { radarQuoteMatchesBlock } from '../../../components/radar/radar-reading-blocks';

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
  topics: Array<{ id: string; slug: string; name: string; tier: string }>;
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
  zread?: {
    status?: 'queued' | 'generating' | 'partial' | 'complete' | 'failed';
    provider?: 'zread-cli' | 'github-readme-fallback' | string;
    commitSha?: string | null;
    expectedPageCount?: number | null;
    error?: string | null;
    fallback?: boolean;
    pages?: Array<{ path?: string; title?: string; content?: string }>;
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
  const [selectionAction, setSelectionAction] = useState<{
    action: 'explain' | 'translate';
    content: string | null;
    prompt: string;
    loading: boolean;
    result: string | null;
    error: string | null;
  } | null>(null);
  const [selectionCopied, setSelectionCopied] = useState(false);
  const [selectionIncomplete, setSelectionIncomplete] = useState(false);
  const [annotationRefreshKey, setAnnotationRefreshKey] = useState(0);
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

  function selectionContexts(range: Range, quote: string): Partial<Record<ContextScope, string>> {
    const container = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const block = container?.closest<HTMLElement>('[data-radar-block="true"]');
    if (!block) return { selection: quote };
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
    return {
      selection: quote,
      paragraph: block.innerText.trim(),
      section: sectionBlocks.map((item) => item.innerText.trim()).filter(Boolean).join('\n\n'),
    };
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
    const handleSelection = () => {
      const selection = window.getSelection();
      const leftCol = leftColRef.current;
      if (!selection || !leftCol || selection.isCollapsed || !selection.toString().trim()) {
        setSelectionPrompt(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!leftCol.contains(range.commonAncestorContainer)) {
        setSelectionPrompt(null);
        return;
      }
      const quote = selection.toString().trim().slice(0, 12000);
      const rect = range.getBoundingClientRect();
      setSelectedAnchor({ quote, startOffset: 0, endOffset: quote.length, contextByScope: selectionContexts(range, quote) });
      chat.setContextScope('selection');
      setSelectionAction(null);
      setSelectionPrompt({
        top: rect.bottom + 10 <= window.innerHeight - 54 ? rect.bottom + 10 : Math.max(12, rect.top - 54),
        left: Math.min(Math.max(12, rect.left + rect.width / 2 - 120), Math.max(12, window.innerWidth - 252)),
      });
    };
    document.addEventListener('mouseup', handleSelection);
    return () => document.removeEventListener('mouseup', handleSelection);
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
  const sourceLabel = formatSourceType(d.sourceType);
  const rawReadingBody = d.originalMarkdown ?? d.body ?? '';
  const contentPending = d.tags.includes('content_pending') || rawReadingBody.trim().length < 200;
  const readingBody = contentPending
    ? d.interpretation ?? d.highlights?.summary ?? d.excerpt
    : d.originalMarkdown ?? d.body ?? d.highlights?.summary ?? d.interpretation ?? d.excerpt;
  const canInteract = Boolean(me.data?.id);
  const hasDedicatedInterpretation = Boolean(
    (d.originalKind === 'github_repo' && d.repoSummary)
    || ((d.originalKind === 'rss' || d.originalKind === 'web_share') && d.highlights),
  );

  if (d.originalKind === 'github_repo' && isZreadRepository(d.url)) {
    const zreadMeta = (d.originalMeta ?? null) as RepoMeta | null;
    const zreadPages = zreadMeta?.zread?.pages?.filter((page) => page.content?.trim()).length ?? 0;
    const zreadExpected = zreadMeta?.zread?.expectedPageCount;
    const zreadStatus = zreadMeta?.zread?.status;
    const zreadContextLabel = zreadPages > 0
      ? `Zread 项目文档 · ${zreadExpected ? `${zreadPages}/${zreadExpected} 页` : `${zreadPages} 页`} · commit ${(zreadMeta?.zread?.commitSha ?? '').slice(0, 8)}`
      : zreadStatus === 'failed'
        ? 'Zread 项目文档生成失败'
        : zreadStatus === 'generating'
          ? 'Zread 项目文档生成中'
          : 'Zread 项目文档尚未生成';
    return (
      <div className="flex h-[calc(100vh-56px)] flex-col">
        <div className="relative flex items-center justify-between border-b border-border bg-background px-4 py-3">
          <div className="flex items-center gap-2">
            <BackToSearchButton />
            <Link href={backHref} className="text-sm text-muted-foreground hover:text-primary">← 回到雷达列表</Link>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground">{sourceLabel.short}</span>
            <span className="rounded-full border border-primary/30 bg-accent px-2 py-0.5 text-[11px] text-accent-foreground">Repo 阅读模式</span>
            <a href={d.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-primary/35 bg-primary/5 px-2.5 text-xs font-medium text-primary hover:bg-primary/10"><ExternalLink className="size-3.5" />打开 GitHub</a>
          </div>
        </div>
        <div className="border-b border-border bg-[var(--ink-page)] px-4 py-3">
          <RadarTopicPicker
            summaryId={d.id}
            topics={d.topics}
            canInteract={canInteract}
            onAdded={() => void q.refetch()}
          />
        </div>
        <RadarZreadDocument
          repositoryUrl={d.url}
          leftColRef={leftColRef}
          meta={zreadMeta}
          onRetry={async () => {
            await fetch(`/api/radar/${d.id}/migrate`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            });
            await q.refetch();
          }}
          onOpenChat={canInteract ? (quote, prompt) => {
            if (quote) setSelectedAnchor({ quote, startOffset: 0, endOffset: quote.length });
            if (prompt) chat.setInput(prompt);
            setChatOpen(true);
          } : undefined}
        />
        {canInteract ? (
          <>
            <FloatingAiIcon isOpen={chatOpen} onClick={() => setChatOpen((v) => !v)} />
            <BottomSheet
              open={chatOpen}
              onOpenChange={setChatOpen}
              title="与 AI 讨论"
              subtitle="基于当前 Repo 文档"
            >
              <ChatPanel
                messages={chat.session?.messages ?? []}
                loading={chat.loading}
                sending={chat.sending}
                thinkingStep={chat.thinkingStep}
                err={chat.err}
                input={chat.input}
                onInputChange={chat.setInput}
                onSubmit={chat.sendMessage}
                onRetryLoad={chat.retryLoad}
                messagesRef={chat.messagesRef}
                textareaRef={chat.textareaRef}
                compact
                contextLabel={zreadContextLabel}
                selectedAnchor={selectedAnchor}
                onClearSelectedAnchor={() => { setSelectedAnchor(null); chat.setContextScope('full'); }}
                contextScope={chat.contextScope}
                onContextScopeChange={chat.setContextScope}
                hasProjectContext
                onSourceClick={handleHighlightClick}
              />
            </BottomSheet>
          </>
        ) : null}
      </div>
    );
  }

  function findRadarBlock(quote: string, sourceBlockIndex?: number, anchorId?: string): HTMLElement | null {
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
  }

  function focusRadarBlock(quote: string | null, scroll = false, sourceBlockIndex?: number, anchorId?: string) {
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
  }

  // AI 地图只在引用被严格验证后点击定位；悬停不再改变正文状态。
  function handleHighlightClick(quote: string, sourceBlockIndex?: number, anchorId?: string) {
    focusRadarBlock(quote, true, sourceBlockIndex, anchorId);
  }

  async function runSelectionAction(action: 'explain' | 'translate') {
    const quote = selectedAnchor?.quote?.trim();
    if (!quote) return;
    const actionContent = action === 'translate' && chat.contextScope !== 'full' && chat.contextScope !== 'project'
      ? selectedAnchor?.contextByScope?.[chat.contextScope]?.trim() || quote
      : quote;
    const prompt = action === 'translate'
      ? `将${chat.contextScope === 'paragraph' ? '当前段落' : chat.contextScope === 'section' ? '当前章节' : '选中的内容'}翻译成简体中文，保留专有名词、公式、链接和原文结构。`
      : '解释选中的术语或片段。先给出清晰定义，再结合上下文说明它在本文中的具体含义、涉及的变量/机制以及为什么重要；如果是公式或指标，说明如何理解。不要只复述“这是一个术语”，也不要因为信息有限就直接拒答。只返回面向读者的解释文本。';
    setSelectionCopied(false);
    setSelectionIncomplete(false);
    setSelectionAction({ action, content: quote, prompt, loading: true, result: null, error: null });
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
      setSelectionAction({ action, content: quote, prompt, loading: false, result, error: null });
    } catch (error) {
      setSelectionAction({ action, content: quote, prompt, loading: false, result: null, error: error instanceof Error ? error.message : '操作暂时不可用' });
    }
  }

  async function copySelectionResult() {
    const result = selectionAction?.result?.trim();
    if (!result || !navigator.clipboard) return;
    await navigator.clipboard.writeText(result);
    setSelectionCopied(true);
    window.setTimeout(() => setSelectionCopied(false), 1800);
  }

  async function copySelectedQuote() {
    const quote = selectedAnchor?.quote?.trim();
    if (!quote || !navigator.clipboard) return;
    await navigator.clipboard.writeText(`> ${quote.replace(/\n/gu, '\n> ')}`);
    setSelectionCopied(true);
    window.setTimeout(() => setSelectionCopied(false), 1800);
  }

  async function saveSelectedAnnotation(note = annotationDraft) {
    const anchor = selectedAnchor;
    const quote = anchor?.quote?.trim();
    if (!anchor || !quote || !canInteract) return;
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
      if (!response.ok) throw new Error('保存高亮失败');
      setSelectionAction({
        action: 'explain',
        content: quote,
        prompt: '',
        loading: false,
        result: '已保存到你的阅读批注。',
        error: null,
      });
      setAnnotationRefreshKey((value) => value + 1);
      setAnnotationComposerOpen(false);
      setAnnotationDraft('');
    } catch (error) {
      setSelectionAction({
        action: 'explain',
        content: quote,
        prompt: '',
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
      content: selectedAnchor.quote,
      prompt: '',
      loading: false,
      result: null,
      error: null,
    });
    setSelectionPrompt(null);
    setAnnotationComposerOpen(true);
  }

  return (
    <div className="flex h-[calc(100vh-56px)] flex-col">
      {/* 顶栏：返回 + 来源 badge + 阅读进度条 */}
      <div className="relative flex items-center justify-between border-b border-border bg-background px-4 py-3">
        <div className="flex items-center gap-2">
          <BackToSearchButton />
          <Link href={backHref} className="text-sm text-muted-foreground hover:text-primary">← 回到雷达列表</Link>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
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
              {d.originalKind === 'arxiv' ? 'arXiv 论文' : d.originalKind}
            </span>
          ) : null}
          <a
            href={d.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-primary/35 bg-primary/5 px-2.5 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <ExternalLink className="size-3.5" />
            打开原文
          </a>
        </div>
        <ReadingProgressBar scrollRef={leftColRef} />
      </div>

      {selectedAnchor && (selectionPrompt || selectionAction?.content === selectedAnchor.quote) ? (
        <div
          className="fixed z-[9980]"
          style={selectionPrompt ?? { top: 88, left: 16 }}
          onMouseDown={(event) => event.stopPropagation()}
          onMouseUp={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-1 rounded-xl border border-border bg-background/95 p-1.5 shadow-xl backdrop-blur">
            <button type="button" onClick={() => void runSelectionAction('explain')} disabled={selectionAction?.loading === true} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-wait disabled:opacity-50">
              <Sparkles className="size-3.5" />解释
            </button>
            <button type="button" onClick={() => void runSelectionAction('translate')} disabled={selectionAction?.loading === true} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-wait disabled:opacity-50">
              <Languages className="size-3.5" />{chat.contextScope === 'paragraph' ? '翻译段落' : chat.contextScope === 'section' ? '翻译章节' : '翻译'}
            </button>
            <button type="button" onClick={() => { setChatOpen(true); setSelectionPrompt(null); }} className="inline-flex items-center gap-1.5 rounded-lg border border-method-ai/30 bg-method-ai/10 px-3 py-2 text-xs font-semibold text-method-ai hover:bg-method-ai/15">
              <MessageCircle className="size-3.5" />问 AI
            </button>
            <button type="button" onClick={openAnnotationComposer} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted">
              <BookmarkPlus className="size-3.5" />批注
            </button>
          </div>
          {selectionAction?.content === selectedAnchor.quote ? (
            <div className="mt-2 max-h-[min(60vh,520px)] w-[min(480px,calc(100vw-24px))] overflow-y-auto overscroll-contain rounded-lg border border-border bg-background p-3 text-sm leading-6 text-foreground shadow-xl">
              <div className="sticky top-0 z-10 -mx-3 -mt-3 mb-3 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-3 pb-2 pt-3 text-[11px] text-muted-foreground backdrop-blur">
                <span>{selectionAction.action === 'explain' ? '解释选中内容' : '翻译选中内容'}</span>
                <button type="button" onClick={() => { setSelectionAction(null); setSelectionPrompt(null); }} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-muted">关闭</button>
              </div>
              <details className="mb-3 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-xs">
                <summary className="cursor-pointer font-medium text-muted-foreground">查看发送给 AI 的内容</summary>
                <div className="mt-2 space-y-2 text-muted-foreground">
                  <div><span className="font-medium text-foreground">选中：</span><span className="whitespace-pre-wrap">{selectedAnchor.quote}</span></div>
                  <div><span className="font-medium text-foreground">指令：</span>{selectionAction.prompt}</div>
                </div>
              </details>
              <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                <span>{selectionAction.action === 'explain' ? '定义 · 上下文 · 本文作用' : '保留原意与专有名词'}</span>
                {selectionAction.result ? (
                  <button type="button" onClick={() => void copySelectionResult()} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-foreground hover:bg-muted" aria-label="复制解释结果">
                    {selectionCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {selectionCopied ? '已复制' : '复制'}
                  </button>
                ) : null}
                {selectionAction.result && selectionAction.action === 'explain' ? (
                  <button type="button" onClick={() => void saveSelectionExplanation()} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-foreground hover:bg-muted" aria-label="保存解释到批注">
                    <BookmarkPlus className="size-3.5" />保存到批注
                  </button>
                ) : null}
                {selectedAnchor.quote ? (
                  <button type="button" onClick={() => void copySelectedQuote()} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-foreground hover:bg-muted" aria-label="复制原文引用">
                    {selectionCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {selectionCopied ? '已复制' : '复制引用'}
                  </button>
                ) : null}
              </div>
              {annotationComposerOpen ? (
                <div className="mb-3 rounded-md border border-[var(--ink-accent)]/25 bg-[var(--ink-accent)]/[0.04] p-2.5">
                  <label className="block text-xs font-medium text-foreground" htmlFor="radar-annotation-note">添加批注</label>
                  <textarea
                    id="radar-annotation-note"
                    value={annotationDraft}
                    onChange={(event) => setAnnotationDraft(event.target.value)}
                    maxLength={2000}
                    rows={3}
                    placeholder="写下你对这段内容的理解或疑问（可选）"
                    className="mt-2 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button type="button" onClick={() => setAnnotationComposerOpen(false)} className="rounded px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted">取消</button>
                    <button type="button" onClick={() => void saveSelectedAnnotation()} className="rounded bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90">保存批注</button>
                  </div>
                </div>
              ) : null}
              {selectionAction.loading ? <span className="text-muted-foreground">正在理解选中内容…（仅发送选区和附近上下文）</span> : null}
              {selectionAction.error ? <span className="text-destructive">{selectionAction.error}</span> : null}
              {selectionIncomplete ? (
                <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-800">
                  当前结果只覆盖已成功处理的内容，部分片段生成失败或被截断。
                </div>
              ) : null}
              {selectionAction.result ? <p className="whitespace-pre-wrap">{selectionAction.result}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 原文主阅读区 + 上下文工具栏。右侧不再渲染第二份正文。 */}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:grid lg:overflow-hidden"
        style={{ gridTemplateColumns: `minmax(0, 1fr) 12px ${aiPanelWidth}px` }}
      >
        <div ref={leftColRef} className="min-w-0 border-r border-border bg-[var(--ink-page)] px-8 py-8 lg:min-h-0 lg:overflow-y-auto">
          <article className="mx-auto w-full max-w-[96rem] leading-7">
            <h1 className="mb-6 font-serif text-3xl font-semibold leading-tight tracking-normal">{d.title}</h1>

            {contentPending ? (
              <div className="mb-7 rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-100">
                <strong>正文正在补抓</strong>
                <span className="ml-2">当前仅展示来源摘要，未使用不完整正文参与评分；访问后会在后台重新抓取并生成。</span>
              </div>
            ) : null}
            <div data-testid="reading-coverage" className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span className={contentPending ? 'font-medium text-amber-800' : 'font-medium text-emerald-700'}>
                正文覆盖：{contentPending ? '不完整' : '已抓取'}
              </span>
              {d.originalKind === 'arxiv' && d.sections?.length ? (
                <span>论文结构：{d.sections.length} 个章节</span>
              ) : null}
              {rawReadingBody.trim() ? <span>{rawReadingBody.length.toLocaleString()} 字符</span> : null}
              {contentPending ? <span>AI 结论不代表全文</span> : null}
            </div>

            {d.distilledScore ? (
                <div className="mb-7">
                <DistilledScorePanel score={d.distilledScore} />
              </div>
            ) : null}

            {!d.distilledScore && d.scoreReason ? (
              <p className="mb-7 text-sm text-muted-foreground">
                <strong>评分理由：</strong>
                {d.scoreReason}
              </p>
            ) : null}

            {d.selectionReason ? (
              <p className="mb-7 rounded-md border-l-2 border-status-succeeded-fg bg-status-succeeded-bg px-3 py-2 text-sm text-status-succeeded-fg">
                <strong>入选理由：</strong>
                {d.selectionReason}
                {d.sortOrder !== null ? `（#${d.sortOrder}）` : ''}
              </p>
            ) : null}

            <RadarTopicPicker
              summaryId={d.id}
              topics={d.topics}
              canInteract={canInteract}
              onAdded={() => void q.refetch()}
            />

            {(d.interpretation && !hasDedicatedInterpretation) || d.originalKind === 'github_repo' || d.originalKind === 'arxiv' || d.githubItemMeta || d.highlights ? (
              <details className="mb-7 rounded-xl border border-border bg-card group">
                <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [&::-webkit-details-marker]:hidden">
                  <span className="mr-2 text-xs text-muted-foreground">按需查看</span>
                  来源分析与结构信息
                  <span className="float-right text-muted-foreground transition-transform group-open:rotate-180">⌄</span>
                </summary>
                <div className="border-t border-border px-4 py-4">
                  {d.interpretation && !hasDedicatedInterpretation ? (
                    <p className="mb-6 rounded-md border-l-2 border-primary bg-accent/60 px-4 py-3 text-sm leading-7 text-foreground">
                      <span className="mr-1.5 text-xs font-medium text-muted-foreground">AI 一句话解读：</span>
                      {d.interpretation}
                    </p>
                  ) : null}

                  {d.originalKind === 'github_repo' && (d.repoSummary || d.originalMeta) ? (
                    <RadarRepoSummary summary={d.repoSummary ?? d.interpretation ?? ''} meta={(d.originalMeta ?? null) as RepoMeta | null} />
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
                    <div>
                      <p className="mb-2 text-xs font-semibold text-muted-foreground">来源摘要与亮点</p>
                      <RadarArticleHighlights {...d.highlights} />
                    </div>
                  ) : null}
                </div>
              </details>
            ) : null}

            {readingBody && readingBody !== d.interpretation && d.sourceType !== 'github_tracked' ? (
              <RadarOriginalArticle
                content={readingBody}
                title={d.title}
                paperMode={d.originalKind === 'arxiv'}
                highlights={d.highlights}
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
          />
        </div>
      </div>

      {canInteract ? (
        <>
          <FloatingAiIcon isOpen={chatOpen} onClick={() => setChatOpen((v) => !v)} />
          <BottomSheet
            open={chatOpen}
            onOpenChange={setChatOpen}
            title="与 AI 讨论"
            subtitle={d.title}
          >
            <ChatPanel
              messages={chat.session?.messages ?? []}
              loading={chat.loading}
              sending={chat.sending}
              thinkingStep={chat.thinkingStep}
              err={chat.err}
              input={chat.input}
              onInputChange={chat.setInput}
              onSubmit={chat.sendMessage}
              onRetryLoad={chat.retryLoad}
              messagesRef={chat.messagesRef}
              textareaRef={chat.textareaRef}
              compact
              selectedAnchor={selectedAnchor}
              onClearSelectedAnchor={() => { setSelectedAnchor(null); chat.setContextScope('full'); }}
              contextScope={chat.contextScope}
              onContextScopeChange={chat.setContextScope}
              hasProjectContext={d.originalKind === 'github_repo' && isZreadRepository(d.url)}
              onSourceClick={handleHighlightClick}
            />
          </BottomSheet>
        </>
      ) : null}
    </div>
  );
}

function RadarTopicPicker({
  summaryId,
  topics,
  canInteract,
  onAdded,
}: {
  summaryId: string;
  topics: Array<{ id: string; slug: string; name: string; tier: string }>;
  canInteract: boolean;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Array<{ id: string; slug: string; name: string; tier: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || items.length) return;
    setLoading(true);
    void fetch('/api/topics?limit=80', { cache: 'no-store' })
      .then((response) => response.json() as Promise<{ items?: typeof items }>)
      .then((body) => setItems(body.items ?? []))
      .catch(() => setError('专题列表加载失败'))
      .finally(() => setLoading(false));
  }, [items.length, open]);

  async function addTopic(topicId: string) {
    setAdding(topicId);
    setError(null);
    try {
      const response = await fetch(`/api/radar/${summaryId}/topics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topicId }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? '加入专题失败');
      }
      onAdded();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加入专题失败');
    } finally {
      setAdding(null);
    }
  }

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 text-xs">
      <span className="font-medium text-muted-foreground">关联专题</span>
      {topics.map((topic) => (
        <Link key={topic.id} href={`/topics/${topic.slug}`} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-muted-foreground hover:border-primary/40 hover:text-primary">
          <BookOpenCheck className="size-3" />{topic.name}
        </Link>
      ))}
      {canInteract ? (
        <div className="relative">
          <button type="button" onClick={() => setOpen((value) => !value)} className="inline-flex items-center gap-1 rounded-full border border-dashed border-primary/50 px-2 py-0.5 font-medium text-primary hover:bg-primary/5">
            <Plus className="size-3" />加入专题
          </button>
          {open ? (
            <div className="absolute left-0 top-full z-30 mt-2 w-72 rounded-md border border-border bg-popover p-2 shadow-lg">
              <p className="px-2 py-1 text-[11px] text-muted-foreground">选择一个技术专题</p>
              {loading ? <p className="px-2 py-3 text-xs text-muted-foreground">加载中…</p> : null}
              <div className="max-h-64 overflow-y-auto">
                {items.filter((item) => !topics.some((topic) => topic.id === item.id)).map((item) => (
                  <button key={item.id} type="button" onClick={() => void addTopic(item.id)} disabled={adding !== null} className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-xs hover:bg-muted disabled:opacity-50">
                    <span>{item.name}</span>
                    {adding === item.id ? <span className="text-muted-foreground">保存中…</span> : null}
                  </button>
                ))}
              </div>
              {error ? <p className="px-2 py-1 text-xs text-destructive">{error}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
