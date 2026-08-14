'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Languages, Loader2, Sparkles, Zap } from 'lucide-react';

import MarkdownContent from '@/components/MarkdownContent';
import { RadarAiReadingTab, type RadarGuide } from './RadarAiReadingTab';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

interface Highlights {
  summary: string;
  highlights: string[];
  keyQuote: string | null;
}

interface RadarRightPanelProps {
  summaryId: string;
  title: string;
  highlights: Highlights | null;
  /** 点击高亮回链时触发（父组件滚动左栏原文） */
  onHighlightClick?: (quote: string) => void;
  className?: string;
}

type TransformState = {
  content: string | null;
  guide: RadarGuide | null;
  chunks: Array<{ index: number; content: string }> | null;
  complete: boolean;
  loading: boolean;
  error: string | null;
};

type Mode = 'ai_reading' | 'translate';

const MODES: Array<{ value: Mode; label: string; description: string }> = [
  { value: 'ai_reading', label: 'AI导读', description: '结论、证据与待验证问题' },
  { value: 'translate', label: '翻译', description: '保留结构的中文译文' },
];

/**
 * 右栏 AI 面板 —— tabs（AI导读 / 翻译）+ transform 调用 + 缓存。
 *
 * AI导读走结构化 guide（M5）；翻译走分块 chunks（M6）。
 */
export function RadarRightPanel({ summaryId, title, highlights, onHighlightClick, className }: RadarRightPanelProps) {
  const [mode, setMode] = useState<Mode>('ai_reading');
  const [language, setLanguage] = useState('zh-CN');
  const [transforms, setTransforms] = useState<Record<string, TransformState>>({});

  const requestTransform = useCallback(async (nextMode: Mode, requestedLanguage: string) => {
    const cacheKey = `${nextMode}:${requestedLanguage}`;
    setTransforms((current) => {
      const existing = current[cacheKey];
      const hasData = existing?.guide || existing?.content || existing?.chunks?.length;
      if (hasData || existing?.loading) return current;
      return { ...current, [cacheKey]: { content: null, guide: null, chunks: null, complete: false, loading: true, error: null } };
    });

    try {
      const response = await fetch(`/api/radar/${summaryId}/transform`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: nextMode, language: requestedLanguage }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        content?: string;
        guide?: RadarGuide | null;
        chunks?: Array<{ index: number; content: string }>;
        complete?: boolean;
        message?: string;
      };
      const hasData = nextMode === 'ai_reading' ? Boolean(body.guide || body.content) : Boolean(body.chunks?.length);
      if (!response.ok || !hasData) {
        throw new Error(body.message ?? '生成阅读内容失败');
      }
      setTransforms((current) => ({
        ...current,
        [cacheKey]: {
          content: body.content ?? null,
          guide: body.guide ?? null,
          chunks: body.chunks ?? null,
          complete: body.complete ?? true,
          loading: false,
          error: null,
        },
      }));
    } catch (error) {
      setTransforms((current) => ({
        ...current,
        [cacheKey]: {
          content: null,
          guide: null,
          chunks: null,
          complete: false,
          loading: false,
          error: error instanceof Error ? error.message : '生成阅读内容失败',
        },
      }));
    }
  }, [summaryId]);

  useEffect(() => {
    const warm = async () => {
      await requestTransform('ai_reading', 'zh-CN');
      await requestTransform('translate', 'zh-CN');
    };
    const timer = window.setTimeout(warm, 80);
    return () => window.clearTimeout(timer);
  }, [requestTransform]);

  const activeKey = `${mode}:${language}`;
  const activeTransform = transforms[activeKey];
  const anyWarmup = Object.values(transforms).some((t) => t.loading);
  const aiReady = Boolean(transforms['ai_reading:zh-CN']?.content);
  const translationReady = Boolean(transforms['translate:zh-CN']?.content);

  function selectMode(nextMode: Mode) {
    setMode(nextMode);
    void requestTransform(nextMode, language);
  }

  function changeLanguage(nextLanguage: string) {
    setLanguage(nextLanguage);
    if (mode === 'translate') void requestTransform('translate', nextLanguage);
  }

  return (
    <div className={cn('flex h-full flex-col', className)}>
      <div className="mb-4">
        <h2 className="font-sans text-lg font-semibold">{title} — 阅读助手</h2>
        <p className="mt-1 flex items-center gap-2 font-sans text-xs text-[var(--ink-muted)]" aria-live="polite">
          {aiReady && translationReady ? (
            <>
              <Check className="size-3.5 text-[#1a6e3a]" /> AI导读与翻译已准备
            </>
          ) : anyWarmup ? (
            <>
              <Loader2 className="size-3.5 animate-spin text-[var(--ink-accent)]" /> 正在准备阅读辅助
            </>
          ) : (
            <>
              <Zap className="size-3.5 text-[var(--ink-accent)]" /> 原文可立即阅读
            </>
          )}
        </p>
      </div>

      <Tabs value={mode} onValueChange={(v) => selectMode(v as Mode)} className="flex-1">
        <TabsList className="mb-4">
          {MODES.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.value === 'translate' ? (
                <Languages className="size-3.5" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="ai_reading" className="m-0">
          {highlights ? (
            <div className="mb-4 rounded-lg border border-[var(--ink-rule)] bg-white p-4">
              <p className="font-serif text-sm leading-6 text-[var(--ink-text)]">{highlights.summary}</p>
              {highlights.highlights.length > 0 ? (
                <ul className="mt-3 space-y-2 font-serif text-sm leading-6 text-[var(--ink-muted)]">
                  {highlights.highlights.map((item) => (
                    <li key={item} className="border-l-2 border-[var(--ink-accent)] pl-3">{item}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {activeTransform?.loading ? (
            <div className="flex min-h-40 items-center justify-center gap-2 rounded-lg border border-[var(--ink-rule)] bg-white text-sm text-[var(--ink-muted)]">
              <Loader2 className="size-4 animate-spin text-[var(--ink-accent)]" />
              正在准备 AI 导读
            </div>
          ) : activeTransform?.error ? (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {activeTransform.error}
            </div>
          ) : activeTransform?.guide ? (
            <RadarAiReadingTab guide={activeTransform.guide} onHighlightClick={onHighlightClick} />
          ) : activeTransform?.content ? (
            <MarkdownContent
              content={activeTransform.content}
              className="font-serif text-[15px] leading-[1.7] text-[var(--ink-text)]"
            />
          ) : (
            <div className="rounded-lg border border-[var(--ink-rule)] bg-white p-5 text-sm text-[var(--ink-muted)]">
              暂无可展示内容。
            </div>
          )}
        </TabsContent>

        <TabsContent value="translate" className="m-0">
          <label className="mb-4 flex items-center gap-2 font-sans text-xs text-[var(--ink-muted)]">
            <Languages className="size-3.5" />
            <select
              value={language}
              onChange={(e) => changeLanguage(e.target.value)}
              className="h-8 rounded-md border border-[var(--ink-rule)] bg-white px-2 text-xs"
              aria-label="翻译目标语言"
            >
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
            </select>
          </label>

          {activeTransform?.loading ? (
            <div className="flex min-h-40 items-center justify-center gap-2 rounded-lg border border-[var(--ink-rule)] bg-white text-sm text-[var(--ink-muted)]">
              <Loader2 className="size-4 animate-spin text-[var(--ink-accent)]" />
              正在翻译
            </div>
          ) : activeTransform?.error ? (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {activeTransform.error}
            </div>
          ) : activeTransform?.chunks?.length ? (
            <div>
              <MarkdownContent
                content={activeTransform.chunks.map((c) => c.content).join('\n\n')}
                className="font-serif text-[15px] leading-[1.7] text-[var(--ink-text)]"
              />
              {!activeTransform.complete ? (
                <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 font-sans text-xs text-amber-700">
                  翻译不完整（部分段落翻译失败），已显示已完成的内容。
                </p>
              ) : null}
            </div>
          ) : activeTransform?.content ? (
            <MarkdownContent
              content={activeTransform.content}
              className="font-serif text-[15px] leading-[1.7] text-[var(--ink-text)]"
            />
          ) : (
            <div className="rounded-lg border border-[var(--ink-rule)] bg-white p-5 text-sm text-[var(--ink-muted)]">
              暂无可展示内容。
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
