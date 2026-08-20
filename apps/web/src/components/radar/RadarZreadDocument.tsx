'use client';

import { useEffect, useMemo, useState } from 'react';
import { BookOpen, ChevronRight, ExternalLink, FileCode2, GitBranch, GitCommitHorizontal, MessageCircle, Sparkles } from 'lucide-react';
import MarkdownContent from '../MarkdownContent';

export const ZREAD_SAMPLE_URL = 'https://github.com/deepseek-ai/deepseek-harness';

/** Repo reading mode is intentionally limited to GitHub repositories. */
export function isZreadRepository(url: string): boolean {
  try {
    return new URL(url).hostname === 'github.com';
  } catch {
    return false;
  }
}

// Kept as a compatibility alias for existing imports during the rollout.
export const isZreadSampleRepository = isZreadRepository;

interface Page {
  path?: string;
  title?: string;
  content?: string;
}

interface Props {
  repositoryUrl: string;
  leftColRef: React.RefObject<HTMLDivElement | null>;
  meta: {
    language?: string | null;
    defaultBranch?: string | null;
    stars?: number | null;
    forks?: number | null;
    lastPushedAt?: string | null;
    description?: string | null;
    zread?: {
      provider?: 'zread-cli' | 'github-readme-fallback' | string;
      status?: 'queued' | 'generating' | 'partial' | 'complete' | 'failed';
      commitSha?: string | null;
      generatedAt?: string | null;
      expectedPageCount?: number | null;
      error?: string | null;
      fallback?: boolean;
      pages?: Page[];
    } | null;
  } | null;
  onOpenChat?: (quote?: string, prompt?: string) => void;
  onRetry?: () => Promise<void> | void;
}

function formatCount(value: number | null | undefined): string | null {
  if (value == null) return null;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function resolveRepoReferences(markdown: string, repositoryUrl: string, ref: string): string {
  // Zread emits source references such as `README.md#L1-L15`. Without a
  // repository base these become links inside the radar app, so resolve them
  // to the exact GitHub tree used for this generated document.
  return markdown.replace(/\]\((?!https?:\/\/|mailto:|#)([^)\s]+)\)/gu, (_match, href: string) => {
    const [path, fragment] = href.split('#', 2);
    const target = `${repositoryUrl.replace(/\/$/u, '')}/blob/${ref}/${path}`;
    return `](${target}${fragment ? `#${fragment}` : ''})`;
  });
}

export function RadarZreadDocument({ repositoryUrl, leftColRef, meta, onOpenChat, onRetry }: Props) {
  const cachedPages = (meta?.zread?.pages ?? []).filter((page) => page.content?.trim());
  const hasCachedWiki = (meta?.zread?.provider === 'zread-cli' || meta?.zread?.provider === 'github-readme-fallback') && cachedPages.length > 0;
  const isReadmeFallback = meta?.zread?.provider === 'github-readme-fallback' || meta?.zread?.fallback === true;
  const status = meta?.zread?.status ?? 'queued';
  const cacheStatus = status === 'partial' ? '部分完成' : status === 'complete' ? '已完成' : status === 'failed' ? '生成失败' : status === 'generating' ? '生成中' : '尚未生成';
  const cachedPageLabel = meta?.zread?.expectedPageCount
    ? `${cachedPages.length}/${meta.zread.expectedPageCount} 页`
    : `${cachedPages.length} 页`;
  const displayCommit = meta?.zread?.commitSha || '未生成';
  const displayGeneratedAt = meta?.zread?.generatedAt?.slice(0, 10) || '—';
  const zreadUrl = repositoryUrl.replace(/^https?:\/\/github\.com\//u, 'https://zread.ai/').replace(/\/$/u, '');
  const [activeId, setActiveId] = useState('zread-overview');
  const [selectionPrompt, setSelectionPrompt] = useState<{ top: number; left: number; quote: string } | null>(null);
  const [retrying, setRetrying] = useState(false);

  const items = useMemo(() => (
    hasCachedWiki
      ? cachedPages.map((page, index) => ({
          id: index === 0 ? 'zread-overview' : `zread-page-${index}`,
          label: page.title || `文档 ${index + 1}`,
          icon: index === 0 ? BookOpen : FileCode2,
        }))
      : []
  ), [cachedPages, hasCachedWiki]);

  useEffect(() => {
    const root = leftColRef.current;
    if (!root) return;
    const sections = items
      .map((item) => document.getElementById(item.id))
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
  }, [items, leftColRef]);

  function handleSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      setSelectionPrompt(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const article = document.querySelector('[data-zread-article]');
    if (!article?.contains(range.commonAncestorContainer)) {
      setSelectionPrompt(null);
      return;
    }
    const quote = selection.toString().trim().slice(0, 12000);
    const rect = range.getBoundingClientRect();
    setSelectionPrompt({
      quote,
      top: Math.max(64, rect.top - 44),
      left: Math.min(Math.max(16, rect.left + rect.width / 2 - 58), window.innerWidth - 132),
    });
  }

  async function retryGeneration() {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div ref={leftColRef} className="min-h-0 flex-1 overflow-y-auto bg-[#f5f7f9]" onMouseUp={handleSelection}>
      <div className="mx-auto max-w-[1480px] px-3 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
        <header className="overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)]">
          <div className="relative overflow-hidden bg-[#101923] px-5 py-7 text-white sm:px-8 lg:px-10 lg:py-9">
            <div className="absolute -right-16 -top-24 size-72 rounded-full bg-cyan-400/10 blur-3xl" aria-hidden />
            <div className="relative flex flex-wrap items-start justify-between gap-6">
              <div className="min-w-0">
                <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-300">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1"><span className="size-1.5 rounded-full bg-cyan-300" />GitHub Repo reader</span>
                  <span className="text-slate-500">·</span>
                  <span className="text-slate-400">{cacheStatus}</span>
                </div>
                <h1 className="break-words text-2xl font-semibold tracking-[-0.03em] sm:text-3xl lg:text-[2.1rem]">{repositoryUrl.replace(/^https?:\/\/github\.com\//u, '').replace(/\/$/u, '')}</h1>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">{meta?.description || '项目原文、结构和代码文档集中在这里阅读。AI 只在你需要时介入，不额外铺一层摘要。'}</p>
              </div>
              <div className="flex flex-wrap gap-2 text-[11px] font-mono text-slate-400">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/50 px-2.5 py-1"><GitCommitHorizontal className="size-3" />{displayCommit === '未生成' ? displayCommit : displayCommit.slice(0, 8)}</span>
                <span className="rounded-full border border-slate-700 bg-slate-900/50 px-2.5 py-1">{cachedPageLabel}</span>
              </div>
            </div>
            <details className="relative mt-6 max-w-3xl text-xs text-slate-400">
              <summary className="cursor-pointer list-none text-slate-300 hover:text-white">查看项目元数据</summary>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                {meta?.language ? <span>{meta.language}</span> : null}
                {meta?.defaultBranch ? <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{meta.defaultBranch}</span> : null}
                {formatCount(meta?.stars) ? <span>★ {formatCount(meta?.stars)}</span> : null}
                {formatCount(meta?.forks) ? <span>⑂ {formatCount(meta?.forks)} forks</span> : null}
                <span>生成于 {displayGeneratedAt}</span>
              </div>
            </details>
          </div>

          {status === 'partial' ? (
            <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs leading-5 text-amber-900 sm:px-8">
              <Sparkles className="mt-0.5 size-3.5 shrink-0" />
              <span>当前是部分缓存（{cachedPageLabel}）。未生成的章节不会被 AI 假装成已读；后台会在 commit 不变时继续补齐。</span>
            </div>
          ) : status === 'failed' ? (
            <div className="flex items-start gap-2 border-b border-rose-200 bg-rose-50 px-5 py-3 text-xs leading-5 text-rose-900 sm:px-8">
              <span className="mt-1 size-2 shrink-0 rounded-full bg-rose-500" />
              <div>
                <p><strong>Zread 文档生成失败。</strong>{meta?.zread?.error || '后台没有生成可用页面，当前只保留 GitHub 元数据。'}</p>
                {onRetry ? (
                  <button type="button" onClick={() => void retryGeneration()} disabled={retrying} className="mt-2 rounded border border-rose-300 bg-white px-2 py-1 font-medium text-rose-800 hover:bg-rose-100 disabled:opacity-50">
                    {retrying ? '正在重新投递…' : '重试生成'}
                  </button>
                ) : null}
              </div>
            </div>
          ) : isReadmeFallback ? (
            <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs leading-5 text-amber-900 sm:px-8">
              <Sparkles className="mt-0.5 size-3.5 shrink-0" />
              <span>当前展示 GitHub README fallback；Zread Wiki 尚未生成完整内容。{meta?.zread?.error ? ` ${meta.zread.error}` : ''}</span>
            </div>
          ) : null}

          <div className={hasCachedWiki ? 'grid lg:grid-cols-[240px_minmax(0,1fr)]' : 'block'}>
            {hasCachedWiki ? <aside className="border-b border-slate-200 bg-slate-50/90 p-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)] lg:self-start lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-5">
              <div className="mb-3 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">文档目录</div>
              <nav className="flex gap-1 overflow-x-auto lg:block" aria-label="项目文档导航">
                {items.map(({ id, label, icon: Icon }) => (
                  <a key={id} href={`#${id}`} aria-current={activeId === id ? 'location' : undefined} className={`group flex shrink-0 items-center gap-2 rounded-xl px-2.5 py-2.5 text-xs transition-colors lg:w-full ${activeId === id ? 'bg-white font-semibold text-slate-950 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white/80 hover:text-slate-950'}`}>
                    <Icon className={`size-3.5 ${activeId === id ? 'text-cyan-700' : 'text-slate-400 group-hover:text-cyan-700'}`} aria-hidden />
                    <span className="truncate">{label}</span>
                    <ChevronRight className={`ml-auto hidden size-3 lg:block ${activeId === id ? 'text-cyan-600' : 'text-slate-300'}`} aria-hidden />
                  </a>
                ))}
              </nav>
              <div className="mt-6 hidden border-t border-slate-200 pt-5 lg:block">
                <p className="px-2 text-[11px] leading-5 text-slate-500">原文是主阅读区。选中一段文字后，可以直接让 AI 解释、翻译或继续追问。</p>
                {onOpenChat ? <button type="button" onClick={() => onOpenChat()} className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-cyan-700 hover:bg-cyan-50 hover:text-cyan-900"><MessageCircle className="size-3.5" />与 AI 讨论</button> : null}
                <a href={zreadUrl} target="_blank" rel="noreferrer" className="mt-2 flex items-center gap-1.5 px-2 text-xs font-medium text-slate-500 hover:text-slate-900"><ExternalLink className="size-3" />在 Zread 中打开</a>
              </div>
            </aside> : null}

            <article data-zread-article className="min-w-0 bg-white px-5 py-8 sm:px-10 sm:py-10 lg:px-16 lg:py-12">
              {hasCachedWiki ? (
                <div className="max-w-3xl text-[15px] leading-8 text-slate-700">
                  {cachedPages.map((page, index) => (
                    <section key={`${page.path ?? 'page'}-${index}`} id={index === 0 ? 'zread-overview' : `zread-page-${index}`} className="mb-16 scroll-mt-6 last:mb-0">
                      <div className="mb-5 flex flex-wrap items-center gap-3 border-b border-slate-100 pb-3">
                        <span className="font-mono text-[11px] font-medium text-cyan-700">{page.path ?? `wiki/page-${index + 1}.md`}</span>
                        <span className="text-[11px] text-slate-400">第 {index + 1} 页</span>
                      </div>
                      <h2 className="mb-6 text-2xl font-semibold tracking-[-0.025em] text-slate-950 sm:text-[1.7rem]">{page.title || `Zread 文档 ${index + 1}`}</h2>
                      <MarkdownContent content={resolveRepoReferences(page.content ?? '', repositoryUrl, meta?.zread?.commitSha || meta?.defaultBranch || 'main')} />
                    </section>
                  ))}
                </div>
              ) : (
                <div className="max-w-2xl rounded-2xl border border-slate-200 bg-slate-50 px-6 py-8 text-[15px] leading-7 text-slate-700">
                  <p className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">Zread project reader</p>
                  <h2 className="mb-3 text-xl font-semibold tracking-tight text-slate-950">{status === 'failed' ? '暂时没有项目文档' : status === 'generating' ? '正在生成项目文档' : '项目文档尚未生成'}</h2>
                  <p>{status === 'failed' ? '这次生成没有成功，因此不展示假目录或不完整的正文。修复后台配置后，可按当前 commit 重试。' : '后台会按仓库 commit 生成并缓存 Zread 页面；完成后这里会出现真实目录和正文。'}</p>
                  {meta?.zread?.error ? <p className="mt-3 rounded-lg bg-white px-3 py-2 text-xs text-rose-700">原因：{meta.zread.error}</p> : null}
                  {status === 'failed' && onRetry ? (
                    <button type="button" onClick={() => void retryGeneration()} disabled={retrying} className="mt-4 rounded-md bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-cyan-800 disabled:opacity-50">
                      {retrying ? '正在重新投递…' : '重试生成项目文档'}
                    </button>
                  ) : null}
                </div>
              )}
            </article>
          </div>
        </header>
        <p className="mx-auto mt-3 max-w-5xl px-1 text-[11px] leading-5 text-slate-500">{isReadmeFallback ? 'GitHub README fallback' : 'Zread CLI'} · {cacheStatus}{hasCachedWiki ? ` · ${cachedPageLabel}` : ''} · commit {displayCommit === '未生成' ? displayCommit : displayCommit.slice(0, 8)}</p>
      </div>

      {selectionPrompt && onOpenChat ? (
        <div className="fixed z-[9980]" style={{ top: selectionPrompt.top, left: selectionPrompt.left }}>
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-xl shadow-slate-950/15">
            <button type="button" onClick={() => { onOpenChat(selectionPrompt.quote, '请解释我选中的这段内容，说明它在当前项目中的作用，并指出必要的上下文。'); setSelectionPrompt(null); }} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-cyan-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"><Sparkles className="size-3.5" />解释</button>
            <button type="button" onClick={() => { onOpenChat(selectionPrompt.quote, '请将我选中的内容翻译成简体中文，保留代码、专有名词、文件名和链接。'); setSelectionPrompt(null); }} className="rounded-lg px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">翻译</button>
            <button type="button" onClick={() => { onOpenChat(selectionPrompt.quote); setSelectionPrompt(null); }} className="rounded-lg px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">问 AI</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
