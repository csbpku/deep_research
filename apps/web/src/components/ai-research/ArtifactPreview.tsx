'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, List, Maximize2, Presentation } from 'lucide-react';
import MarkdownContent from '@/components/MarkdownContent';

function splitSlides(content: string): string[] {
  const normalized = content.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) return [];
  const slides = normalized.split(/\n(?=#{1,2}\s*(?:Slide|幻灯片)\b)/iu).map((slide) => slide.trim()).filter(Boolean);
  return slides.length > 1 ? slides : [normalized];
}

function slideTitle(content: string, index: number): string {
  const heading = content.match(/^#{1,3}\s+(.+)$/mu)?.[1]?.trim();
  if (!heading) return index === 0 ? '开场与研究问题' : `第 ${index + 1} 页`;
  return heading.replace(/^(?:Slide|幻灯片)\s*\d*\s*[:：-]?\s*/iu, '').trim() || `第 ${index + 1} 页`;
}

function slideBody(content: string): string {
  return content.replace(/^#{1,3}\s+.+$/mu, '').trim();
}

interface SlideStageContent {
  lead: string;
  bullets: string[];
  hiddenCount: number;
  truncated: boolean;
}

interface StageText {
  text: string;
  truncated: boolean;
}

/**
 * Keep the stage a speaking surface even when an older artifact contains a
 * report-sized paragraph. This is presentation-only: the outline view and
 * the screen-reader list still expose the original content in full.
 */
function compactStageText(value: string, limit: number): StageText {
  const normalized = value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[\\*_`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized.length <= limit) return { text: normalized, truncated: false };

  // Prefer a complete sentence when the source gives us one early enough.
  const sentenceEnd = normalized.search(/[。！？.!?](?=\s|$)/u);
  if (sentenceEnd >= Math.min(48, limit - 20) && sentenceEnd < limit) {
    return { text: normalized.slice(0, sentenceEnd + 1), truncated: true };
  }
  return { text: `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`, truncated: true };
}

/**
 * A 16:9 stage is a speaking surface, not a shrunken report reader. Keep the
 * first useful idea and a few points on stage while the outline mode and the
 * screen-reader list retain the complete slide content.
 */
function slideStageContent(content: string): SlideStageContent {
  const body = slideBody(content);
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  const bullets = lines
    .filter((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(line))
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, '').trim())
    .filter(Boolean);
  const paragraphs = lines.filter((line) => (
    !/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(line)
    && !/^#{1,6}\s+/u.test(line)
    && !/^\|/.test(line)
  ));
  const leadResult = paragraphs[0] ? compactStageText(paragraphs[0], 220) : { text: '', truncated: false };
  const visibleBullets = bullets.slice(0, 3).map((bullet) => compactStageText(bullet, 150));
  const lead = leadResult.text;
  const hiddenCount = Math.max(0, bullets.length - visibleBullets.length) + Math.max(0, paragraphs.length - (lead ? 1 : 0));
  return {
    lead,
    bullets: visibleBullets.map(({ text }) => text),
    hiddenCount,
    truncated: leadResult.truncated || visibleBullets.some(({ truncated }) => truncated),
  };
}

function slideStorageKey(content: string): string {
  // A small deterministic key keeps the user's place for this artifact
  // without storing the report itself or coupling it to a job id.
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ai-research-slides:v2:${hash >>> 0}`;
}

function slideKicker(content: string, index: number): string {
  if (index === 0) return 'THE QUESTION';
  const title = slideTitle(content, index);
  if (/风险|局限|挑战|代价|risk|limitation|trade.?off/iu.test(title)) return 'TRADE-OFF';
  if (/行动|下一步|建议|落地|action|recommendation|next/iu.test(title)) return 'NEXT MOVE';
  if (/比较|对比|取舍|compare|comparison/iu.test(title)) return 'COMPARISON';
  if (/证据|来源|核验|evidence|source/iu.test(title)) return 'SOURCE CHECK';
  return `FINDING ${String(index).padStart(2, '0')}`;
}

export function ArtifactPreview({ content }: { content: string }) {
  const slides = splitSlides(content);
  if (slides.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground" aria-label="Slides 提纲预览">
        暂无可预览的演示提纲。
      </section>
    );
  }

  const [mode, setMode] = useState<'stage' | 'outline'>('stage');
  const [current, setCurrent] = useState(0);
  const storageKey = useMemo(() => slideStorageKey(content), [content]);
  const currentSlide = slides[current] ?? slides[0];
  const stageContent = slideStageContent(currentSlide);

  useEffect(() => {
    try {
      const saved = Number.parseInt(window.localStorage.getItem(storageKey) ?? '', 10);
      if (Number.isInteger(saved) && saved >= 0) {
        setCurrent(Math.min(slides.length - 1, saved));
      }
    } catch {
      // Private browsing or a restricted storage context should not affect
      // the presentation preview.
    }
  }, [slides.length, storageKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(current));
    } catch {
      // The in-memory cursor remains fully usable when storage is unavailable.
    }
  }, [current, storageKey]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (mode !== 'stage') return;
      if (event.key === 'ArrowRight' || event.key === ' ') {
        event.preventDefault();
        setCurrent((value) => Math.min(slides.length - 1, value + 1));
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setCurrent((value) => Math.max(0, value - 1));
      } else if (event.key === 'Home') {
        setCurrent(0);
      } else if (event.key === 'End') {
        setCurrent(slides.length - 1);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, slides.length]);

  return (
    <section className="space-y-4" aria-label="Slides 提纲预览">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-primary/20 bg-primary/[0.035] px-4 py-3.5">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground"><Presentation className="size-4 text-primary" />Slides 提纲预览</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            演示模式适合讲解或录屏；列表模式适合核对每页内容。它仍是按页组织的研究提纲，不是可下载的 .pptx 文件。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex rounded-lg border border-border bg-background p-0.5" role="group" aria-label="Slides 预览模式">
            <button type="button" aria-pressed={mode === 'stage'} onClick={() => setMode('stage')} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ${mode === 'stage' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}><Maximize2 className="size-3" />演示</button>
            <button type="button" aria-pressed={mode === 'outline'} onClick={() => setMode('outline')} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ${mode === 'outline' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}><List className="size-3" />列表</button>
          </div>
          <span className="rounded-full border border-border bg-background px-2.5 py-1 font-mono text-[11px] tabular-nums text-muted-foreground">{slides.length} 页</span>
        </div>
      </div>
      {mode === 'stage' ? (
        <div className="space-y-3">
          <div
            role="button"
            tabIndex={0}
            aria-label={`演示第 ${current + 1} 页：${slideTitle(currentSlide, current)}`}
            aria-live="polite"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('a,button')) return;
              setCurrent((value) => Math.min(slides.length - 1, value + 1));
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setCurrent((value) => Math.min(slides.length - 1, value + 1));
              }
            }}
            data-slide-stage="true"
            className="group relative block aspect-video w-full overflow-hidden rounded-[1.25rem] border border-foreground/30 bg-foreground text-left text-background shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:bg-card dark:text-foreground"
          >
            <span className="absolute -right-12 -top-16 size-52 rounded-full border border-tier-skim/20 transition-transform duration-700 motion-reduce:transition-none group-hover:scale-110" aria-hidden />
            <span className="absolute bottom-[-24%] left-[38%] h-[120%] w-px rotate-[28deg] bg-tier-skim/15" aria-hidden />
            <div className="relative grid h-full grid-rows-[auto_1fr_auto] p-5 sm:p-9 lg:p-12">
              <div className="flex items-center justify-between gap-3 text-[10px] font-medium uppercase tracking-[0.18em] text-background/65 dark:text-muted-foreground">
                <span>Research / visual briefing</span>
                <span className="font-mono text-tier-skim">{String(current + 1).padStart(2, '0')} / {String(slides.length).padStart(2, '0')}</span>
              </div>
              <div className="flex min-h-0 max-w-4xl flex-col justify-center py-5 sm:py-8">
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-tier-skim">{slideKicker(currentSlide, current)}</p>
                <h2 className="mt-3 max-w-3xl font-serif text-2xl font-medium leading-tight tracking-[-0.03em] sm:text-4xl lg:text-6xl">{slideTitle(currentSlide, current)}</h2>
                <div data-slide-scroll className="mt-5 max-h-[42%] overflow-y-auto pr-2 text-sm leading-6 text-background/75 sm:max-w-3xl sm:text-base sm:leading-7 lg:text-lg dark:text-muted-foreground">
                  {stageContent.lead ? <MarkdownContent content={stageContent.lead} compact className="[&_p]:my-0 [&_strong]:text-tier-skim" /> : null}
                  {stageContent.bullets.length > 0 ? (
                    <ul className="mt-3 space-y-2.5">
                      {stageContent.bullets.map((bullet, index) => (
                        <li key={`${index}-${bullet.slice(0, 32)}`} className="flex gap-2.5">
                          <span className="mt-[0.65em] size-1.5 shrink-0 rounded-full bg-tier-skim" aria-hidden />
                          <MarkdownContent content={bullet} compact className="min-w-0 [&_p]:my-0 [&_strong]:text-tier-skim" />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {stageContent.hiddenCount > 0 || stageContent.truncated ? (
                    <p className="mt-3 text-xs text-background/55 dark:text-muted-foreground/70">
                      舞台显示短摘录；切换到“列表”查看完整提纲。
                    </p>
                  ) : null}
                  {!stageContent.lead && stageContent.bullets.length === 0 ? (
                    <MarkdownContent content={slideBody(currentSlide)} compact className="[&_h1]:hidden [&_h2]:hidden [&_h3]:hidden [&_p]:my-1 [&_ul]:my-2 [&_li]:my-1 [&_strong]:text-tier-skim" />
                  ) : null}
                </div>
              </div>
              <div className="flex items-end justify-between gap-3 border-t border-background/15 pt-3 text-[10px] text-background/60 sm:pt-5 dark:border-foreground/15 dark:text-muted-foreground">
                <span>点击舞台或使用 ← → / 空格推进 · 列表模式核对完整提纲</span>
                <span className="hidden sm:inline">证据优先 · 结论可核验</span>
              </div>
            </div>
          </div>
          <ol className="sr-only" aria-label="所有 Slides 内容">
            {slides.map((slide, index) => <li key={`accessible-${index}`}>Slide {String(index + 1).padStart(2, '0')} · 第 {index + 1} 页：{slideTitle(slide, index)} · {slide}</li>)}
          </ol>
          <div className="flex items-center justify-between gap-3" data-no-advance="true">
            <button type="button" onClick={() => setCurrent((value) => Math.max(0, value - 1))} disabled={current === 0} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"><ChevronLeft className="size-3.5" />上一页</button>
            <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5" aria-label="Slides 页码">
              {slides.map((slide, index) => <button type="button" key={`${index}-${slide.slice(0, 24)}`} aria-label={`跳到第 ${index + 1} 页`} aria-current={current === index ? 'page' : undefined} onClick={() => setCurrent(index)} className={`h-1.5 rounded-full transition-all ${current === index ? 'w-8 bg-primary' : 'w-1.5 bg-border hover:bg-primary/50'}`} />)}
            </div>
            <button type="button" onClick={() => setCurrent((value) => Math.min(slides.length - 1, value + 1))} disabled={current === slides.length - 1} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40">下一页<ChevronRight className="size-3.5" /></button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {slides.map((slide, index) => (
            <article key={`${index}-${slide.slice(0, 24)}`} aria-label={`第 ${index + 1} 页：${slideTitle(slide, index)}`} className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
              <div className="flex items-start justify-between gap-3 border-b border-border/70 pb-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Slide {String(index + 1).padStart(2, '0')}</p>
                <p className="min-w-0 truncate text-right text-xs font-medium text-foreground" title={slideTitle(slide, index)}>{slideTitle(slide, index)}</p>
              </div>
              <div className="pt-4">
                <h3 className="text-base font-semibold leading-6 text-foreground">{slideTitle(slide, index)}</h3>
                <MarkdownContent content={slideBody(slide)} compact className="mt-3 text-sm" />
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
