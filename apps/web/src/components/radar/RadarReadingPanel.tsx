'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Languages, Loader2, Sparkles, Zap } from 'lucide-react';

import MarkdownContent from '@/components/MarkdownContent';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type ReadingMode = 'ai_reading' | 'translate' | 'original';

interface Props {
  summaryId: string;
  title: string;
  originalContent: string;
  highlights: {
    summary: string;
    highlights: string[];
    keyQuote: string | null;
  } | null;
}

type TransformState = {
  content: string | null;
  loading: boolean;
  error: string | null;
};

const MODES: Array<{
  value: ReadingMode;
  label: string;
  description: string;
}> = [
  { value: 'ai_reading', label: 'AI 阅读', description: '结论、证据与待验证问题' },
  { value: 'translate', label: '翻译', description: '保留结构的中文译文' },
  { value: 'original', label: '原文', description: '逐段阅读原始内容' },
];

function normalizeQuote(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 100).toLowerCase();
}

function highlightedSourceBlocks(content: string, keyQuote: string | null): string[] {
  const needle = normalizeQuote(keyQuote ?? '');
  if (!needle) return [];
  return content
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => normalizeQuote(block).includes(needle));
}

export function RadarReadingPanel({ summaryId, title, originalContent, highlights }: Props) {
  const [mode, setMode] = useState<ReadingMode>('ai_reading');
  const [language, setLanguage] = useState('zh-CN');
  const [transforms, setTransforms] = useState<Record<string, TransformState>>({});

  const requestTransform = useCallback(async (
    nextMode: Exclude<ReadingMode, 'original'>,
    requestedLanguage: string,
  ) => {
    const cacheKey = `${nextMode}:${requestedLanguage}`;
    setTransforms((current) => {
      const existing = current[cacheKey];
      if (existing?.content || existing?.loading) return current;
      return { ...current, [cacheKey]: { content: null, loading: true, error: null } };
    });

    try {
      const response = await fetch(`/api/radar/${summaryId}/transform`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: nextMode, language: requestedLanguage }),
      });
      const body = await response.json().catch(() => ({})) as {
        content?: string;
        message?: string;
      };
      if (!response.ok || !body.content) {
        throw new Error(body.message ?? '生成阅读内容失败');
      }
      setTransforms((current) => ({
        ...current,
        [cacheKey]: { content: body.content ?? null, loading: false, error: null },
      }));
    } catch (error) {
      setTransforms((current) => ({
        ...current,
        [cacheKey]: {
          content: null,
          loading: false,
          error: error instanceof Error ? error.message : '生成阅读内容失败',
        },
      }));
    }
  }, [summaryId]);

  // The reader should feel ready when it opens. Warm both common modes in
  // parallel after the first paint; original content never waits on AI.
  useEffect(() => {
    const warm = async () => {
      await requestTransform('ai_reading', 'zh-CN');
      await requestTransform('translate', 'zh-CN');
    };
    const timer = window.setTimeout(warm, 80);
    return () => window.clearTimeout(timer);
  }, [requestTransform]);

  const activeKey = mode === 'original' ? null : `${mode}:${language}`;
  const activeTransform = activeKey ? transforms[activeKey] : null;
  const highlightedBlocks = useMemo(
    () => highlightedSourceBlocks(originalContent, highlights?.keyQuote ?? null),
    [originalContent, highlights?.keyQuote],
  );
  const leftContent = mode === 'original' ? originalContent : activeTransform?.content;
  const leftTitle = mode === 'original' ? '原文' : mode === 'translate' ? '中文翻译' : 'AI 阅读';
  const leftDescription = MODES.find((item) => item.value === mode)?.description;
  const anyWarmup = Object.values(transforms).some((item) => item.loading);
  const aiReady = Boolean(transforms['ai_reading:zh-CN']?.content);
  const translationReady = Boolean(transforms['translate:zh-CN']?.content);

  function selectMode(nextMode: ReadingMode) {
    setMode(nextMode);
    if (nextMode !== 'original') {
      void requestTransform(nextMode, language);
    }
  }

  function changeLanguage(nextLanguage: string) {
    setLanguage(nextLanguage);
    if (mode === 'translate') void requestTransform('translate', nextLanguage);
  }

  return (
    <section className="my-9 overflow-hidden rounded-2xl border border-[#d9d6cc] bg-[#f4f2ec] shadow-[0_18px_50px_rgba(35,35,25,0.08)]" aria-labelledby="radar-reading-workbench">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[#d9d6cc] px-5 py-5 sm:px-7">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#706f65]">
            <Sparkles className="size-3.5 text-[#b85b35]" />
            阅读工作台
          </div>
          <h2 id="radar-reading-workbench" className="mt-1.5 text-xl font-semibold tracking-tight text-[#24251f]">
            {title}
          </h2>
          <p className="mt-1 text-xs text-[#77766d]">左侧读结论，右侧核对证据；AI 内容会在打开页面后提前准备。</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-[#77766d]" aria-live="polite">
          {aiReady && translationReady ? (
            <>
              <Check className="size-3.5 text-[#3f7b59]" />
              AI 阅读与翻译已准备
            </>
          ) : anyWarmup ? (
            <>
              <Loader2 className="size-3.5 animate-spin text-[#b85b35]" />
              正在准备阅读辅助
            </>
          ) : (
            <>
              <Zap className="size-3.5 text-[#b85b35]" />
              原文可立即阅读
            </>
          )}
        </div>
      </header>

      <div className="grid lg:grid-cols-[minmax(0,1.12fr)_minmax(340px,0.88fr)]">
        <article className="min-w-0 border-b border-[#d9d6cc] bg-[#fbfaf7] px-5 py-6 sm:px-7 lg:border-b-0 lg:border-r">
          <div className="mb-5 flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#706f65]">{leftTitle}</p>
              <p className="mt-1 text-xs text-[#8a887e]">{leftDescription}</p>
            </div>
            {mode === 'translate' ? (
              <label className="flex items-center gap-2 text-xs text-[#77766d]">
                <Languages className="size-3.5" />
                <select
                  value={language}
                  onChange={(event) => changeLanguage(event.target.value)}
                  className="h-8 rounded-md border border-[#d9d6cc] bg-white px-2 text-xs text-[#24251f]"
                  aria-label="翻译目标语言"
                >
                  <option value="zh-CN">简体中文</option>
                  <option value="en">English</option>
                  <option value="ja">日本語</option>
                </select>
              </label>
            ) : null}
          </div>

          {mode === 'ai_reading' && highlights ? (
            <div className="mb-5 rounded-xl border border-[#ead8c9] bg-[#fff8f1] p-4">
              <p className="text-sm font-medium leading-6 text-[#49352a]">{highlights.summary}</p>
              {highlights.highlights.length > 0 ? (
                <ul className="mt-3 space-y-2 text-sm leading-6 text-[#6d5b4e]">
                  {highlights.highlights.map((item) => <li key={item} className="border-l-2 border-[#c97a51] pl-3">{item}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}

          {activeTransform?.loading ? (
            <div className="flex min-h-40 items-center justify-center gap-2 rounded-xl border border-[#e1ded5] bg-white text-sm text-[#77766d]">
              <Loader2 className="size-4 animate-spin text-[#b85b35]" />
              正在准备{mode === 'translate' ? '翻译' : 'AI 导读'}，原文证据已在右侧。
            </div>
          ) : activeTransform?.error ? (
            <div role="alert" className="rounded-xl border border-[#e5bdb5] bg-[#fff4f1] p-4 text-sm text-[#9d4638]">
              {activeTransform.error}
            </div>
          ) : leftContent ? (
            <MarkdownContent content={leftContent} className="reading-workbench-markdown text-[15px] leading-8 text-[#303129]" />
          ) : (
            <div className="rounded-xl border border-[#e1ded5] bg-white p-5 text-sm text-[#77766d]">暂无可展示内容。</div>
          )}
        </article>

        <aside className="min-w-0 bg-[#eeece5] px-5 py-6 sm:px-7" aria-label="原文证据与阅读模式">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#706f65]">阅读模式</p>
              <p className="mt-1 text-xs text-[#8a887e]">切换左侧的阅读辅助，右侧始终保留证据。</p>
            </div>
            <span className="rounded-full bg-[#dedbd1] px-2 py-1 text-[10px] font-medium text-[#706f65]">双栏</span>
          </div>

          <div className="mt-4 grid gap-1 rounded-xl border border-[#d9d6cc] bg-[#f8f7f3] p-1.5">
            {MODES.map((item) => (
              <Button
                key={item.value}
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  'h-auto justify-start rounded-lg px-3 py-2.5 text-left text-[#4a4a42] hover:bg-white',
                  mode === item.value && 'bg-white text-[#24251f] shadow-sm',
                )}
                onClick={() => selectMode(item.value)}
                aria-pressed={mode === item.value}
              >
                <span className="mr-2 text-[#b85b35]">{item.value === 'translate' ? <Languages className="size-3.5" /> : item.value === 'ai_reading' ? <Sparkles className="size-3.5" /> : <span className="block size-1.5 rounded-full bg-current" />}</span>
                <span>
                  <span className="block text-xs font-semibold">{item.label}</span>
                  <span className="mt-0.5 block text-[11px] text-[#8a887e]">{item.description}</span>
                </span>
              </Button>
            ))}
          </div>

          <div className="mt-6 border-t border-[#d9d6cc] pt-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#706f65]">原文证据</p>
                <p className="mt-1 text-xs text-[#8a887e]">高亮段落来自 AI 阅读结果</p>
              </div>
              {highlightedBlocks.length > 0 ? <span className="text-[11px] font-medium text-[#b85b35]">{highlightedBlocks.length} 段高亮</span> : null}
            </div>

            {highlightedBlocks.length > 0 ? (
              <div className="mt-4 space-y-3">
                {highlightedBlocks.map((block) => (
                  <div key={block} className="rounded-xl border-l-2 border-[#b85b35] bg-[#fffaf4] px-4 py-3 shadow-sm">
                    <MarkdownContent content={block} compact className="text-sm leading-6 text-[#4f4138]" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-xl border border-[#d9d6cc] bg-[#f8f7f3] p-4 text-sm leading-6 text-[#77766d]">
                AI 尚未标出特定段落；你可以先从左侧结论进入，再回到这里核对原文。
              </div>
            )}

            <details className="mt-4 rounded-xl border border-[#d9d6cc] bg-[#f8f7f3] p-4">
              <summary className="cursor-pointer text-xs font-semibold text-[#4a4a42]">展开完整原文</summary>
              <MarkdownContent content={originalContent} compact className="mt-4 max-h-[520px] overflow-y-auto text-sm leading-6 text-[#5b5a51]" />
            </details>
          </div>
        </aside>
      </div>
    </section>
  );
}
