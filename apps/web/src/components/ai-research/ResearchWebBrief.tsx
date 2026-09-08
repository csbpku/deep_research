'use client';

import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  ExternalLink,
  ListChecks,
  Quote,
  ShieldCheck,
  Waypoints,
} from 'lucide-react';
import React from 'react';
import type { ReactNode } from 'react';

import MarkdownContent from '@/components/MarkdownContent';
import {
  extractBulletsFromSections,
  extractDecisionSummaryDetails,
  extractEvidenceMap,
  extractSections,
  type ResearchOutputSource,
} from '@/components/ai-research/ResearchOutputViews';
import { extractResearchTitle, cleanEvidenceSnippet } from '@/lib/research-report';
import { researchUserStatus } from '@/lib/research-user-status';
import { cn } from '@/lib/utils';

export interface ResearchWebBriefProps {
  content: string;
  sources?: ResearchOutputSource[];
  title?: string;
  reviewStatus?: string | null;
  showQualityStatus?: boolean;
}

/**
 * 独立的网页阅读层。
 *
 * 这里不读取 Slides，也不把 Slides 当成中间格式。它直接从原始研究稿
 * 的标题、章节、引用和来源账本组织响应式页面；因此演示模式和阅读模式
 * 可以各自优化，而事实仍然只有一份。
 */
export function ResearchWebBrief({ content, sources = [], title, reviewStatus, showQualityStatus = true }: ResearchWebBriefProps) {
  const sections = extractSections(content);
  const summary = extractDecisionSummaryDetails(content);
  const risks = extractBulletsFromSections(content, /风险|局限|挑战|代价|注意|限制|risk|limitation/iu);
  const actions = extractBulletsFromSections(content, /行动|下一步|建议|验证|落地|action|recommendation|next/iu);
  const evidenceMap = extractEvidenceMap(content, sources);
  const inspectableSources = sources.filter((source) => source.href && source.snippet?.trim()).length;
  const findings = sections
    .filter((section) => section.level >= 2 && !isMetaSection(section.heading) && hasSectionContent(section.body))
    .slice(0, 3);
  // Summary, risk, action and evidence sections are promoted above the long
  // form body. Rendering them again below would make the reader reconcile
  // duplicate copies of the same conclusion.
  const articleSections = sections.filter((section, index) => (
    section.level >= 1
    && hasSectionContent(section.body)
    && !(index === 0 && section.level === 1)
    && !isPromotedSection(section.heading)
  ));
  const readingMinutes = Math.max(1, Math.ceil(content.length / 420));
  const displayTitle = title?.trim() || extractResearchTitle(content);
  const summaryText = compactBriefSummary(summary.text);
  const userStatus = researchUserStatus({
    status: 'succeeded',
    reportType: 'web_brief',
    hasReport: true,
    reviewStatus,
    capturedSourcesCount: inspectableSources,
  });
  const requiresAttention = showQualityStatus && userStatus.code !== 'ready';

  return (
    <article className="overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-xl print:rounded-none print:shadow-none" aria-label="网页简报">
      <header className="relative overflow-hidden border-b border-border bg-foreground px-5 py-8 text-background sm:px-9 sm:py-11">
        <div className="absolute -right-16 -top-20 size-56 rounded-full border border-tier-skim/20" aria-hidden />
        <div className="absolute -right-4 -top-8 size-32 rounded-full border border-tier-skim/15" aria-hidden />
        <div className="relative max-w-3xl">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-medium uppercase tracking-[0.18em] text-tier-skim">
            <span>Research brief</span>
            <span className="text-background/60">/</span>
            <span>独立网页阅读版</span>
          </div>
          <h1 className="mt-4 max-w-3xl font-serif text-3xl font-medium leading-tight tracking-[-0.03em] sm:text-5xl">{displayTitle}</h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-background/80 sm:text-base">
            一页看懂判断、证据、限制和下一步。这个页面直接来自原始研究稿，不经过 Slides 转换。
          </p>
          <div className="mt-7 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)] sm:items-end">
            <div className="flex flex-wrap items-center gap-2 text-xs text-background/80">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-background/20 px-2.5 py-1"><BookOpen className="size-3.5" />约 {readingMinutes} 分钟阅读</span>
              {showQualityStatus ? <span className="inline-flex items-center gap-1.5 rounded-full border border-background/20 px-2.5 py-1"><ShieldCheck className="size-3.5" />{userStatus.label}</span> : null}
              <span className="inline-flex items-center gap-1.5 rounded-full border border-background/20 px-2.5 py-1">{sources.length > 0 ? `${inspectableSources}/${sources.length} 条来源有可核对正文` : '本轮未保存来源'}</span>
            </div>
            <div className="border-l border-background/15 pl-3 text-xs leading-5 text-background/70 sm:justify-self-end sm:max-w-[260px]">
              <p className="font-medium text-tier-skim">阅读路径</p>
              <p className="mt-0.5">先看判断，再看发现，最后回到证据和原文。</p>
            </div>
          </div>
        </div>
      </header>

      <nav className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-border bg-background/95 px-5 py-2.5 text-xs backdrop-blur print:hidden sm:px-9" aria-label="网页简报目录">
        <a className="shrink-0 rounded-full px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" href="#web-brief-summary">判断</a>
        <a className="shrink-0 rounded-full px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" href="#web-brief-findings">发现</a>
        <a className="shrink-0 rounded-full px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" href="#web-brief-report">详细报告</a>
        <a className="shrink-0 rounded-full px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" href="#web-brief-evidence">证据</a>
      </nav>

      <div className="grid gap-8 px-5 py-7 sm:px-9 sm:py-9 lg:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0 space-y-9">
          <section id="web-brief-summary" className="scroll-mt-6" aria-labelledby="web-brief-summary-title">
            <div className="flex items-center gap-2 text-primary"><CheckCircle2 className="size-4" /><h2 id="web-brief-summary-title" className="text-xs font-semibold uppercase tracking-[0.14em]">一页判断</h2></div>
            <div className="mt-3 border-l-2 border-tier-skim bg-accent px-4 py-4 sm:px-5">
              <div className="prose max-w-none text-[15px] leading-7 text-foreground [&_p]:my-0 [&_ul]:my-2">
                {summaryText ? <MarkdownContent content={summaryText} compact /> : <p>报告没有明确的摘要或结论章节，请继续阅读详细报告。</p>}
              </div>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {summary.explicit ? '这是报告中明确写出的摘要/结论；详细依据和限定条件见下方。' : '这是报告开头的有限摘录，不代表完整结论。'}
            </p>
          </section>

          {requiresAttention ? (
            <div className="flex gap-3 border border-warning-border bg-warning-bg px-4 py-3 text-xs leading-5 text-warning-fg" role="status">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{userStatus.description} 来源链接和原文摘录保留在“证据”部分，可以按需回查。</p>
            </div>
          ) : null}

          <section id="web-brief-findings" className="scroll-mt-6" aria-labelledby="web-brief-findings-title">
            <div className="flex items-center gap-2 text-primary"><ListChecks className="size-4" /><h2 id="web-brief-findings-title" className="text-xs font-semibold uppercase tracking-[0.14em]">关键发现</h2></div>
            {findings.length > 0 ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {findings.map((section, index) => {
                  const citationCount = evidenceMap.find((row) => row.section === section.heading)?.citations.length ?? 0;
                  return (
                    <article key={`${section.heading}-${index}`} className="border border-border bg-card px-4 py-4 transition-colors hover:border-primary/35">
                      <span className="font-mono text-[11px] text-tier-skim">0{index + 1}</span>
                      <h3 className="mt-3 line-clamp-3 text-sm font-semibold leading-5">{section.heading}</h3>
                      <p className="mt-3 line-clamp-5 text-xs leading-5 text-muted-foreground">{sectionLead(section.body)}</p>
                      <p className="mt-4 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                        {citationCount > 0 ? `可回链证据 · ${citationCount}` : '正文未建立回链'}
                      </p>
                    </article>
                  );
                })}
              </div>
            ) : <p className="mt-3 text-sm text-muted-foreground">报告没有可识别的章节结构。</p>}
          </section>

          {(risks.length > 0 || actions.length > 0) ? (
            <section className="grid gap-4 sm:grid-cols-2" aria-label="风险与行动">
              {risks.length > 0 ? <ListBlock title="风险与限制" icon={<AlertTriangle className="size-4" />} items={risks} tone="risk" /> : null}
              {actions.length > 0 ? <ListBlock title="下一步行动" icon={<Waypoints className="size-4" />} items={actions} tone="action" /> : null}
            </section>
          ) : null}

          <section id="web-brief-report" className="scroll-mt-6" aria-labelledby="web-brief-report-title">
            <div className="flex items-center gap-2 text-primary"><BookOpen className="size-4" /><h2 id="web-brief-report-title" className="text-xs font-semibold uppercase tracking-[0.14em]">详细报告</h2></div>
            <div className="mt-3 space-y-7">
              {articleSections.length > 0 ? articleSections.map((section, index) => (
                <section key={`${section.heading}-${index}`} id={`web-brief-section-${index}`} className={cn('scroll-mt-6', section.level === 1 && index > 0 && 'border-t border-border pt-6')}>
                  {section.level === 1 ? <h2 className="font-serif text-2xl font-medium tracking-[-0.02em]">{section.heading}</h2> : <h3 className="text-lg font-semibold tracking-[-0.01em]">{section.heading}</h3>}
                  <div className="prose mt-3 max-w-none text-[14px] leading-7 text-foreground/80 [&_a]:text-primary [&_blockquote]:border-tier-skim [&_blockquote]:bg-warning-bg/50 [&_blockquote]:px-4 [&_table]:text-xs">
                    <MarkdownContent content={section.body.join('\n').trim() || '本节暂无正文。'} compact />
                  </div>
                </section>
              )) : (
                <div className="border border-dashed border-border px-4 py-4 text-sm leading-6 text-muted-foreground">
                  摘要、风险和下一步已经在上方整理；本报告没有可单独展开的分析正文。需要逐字核对时，请回到研究稿或下方证据。
                </div>
              )}
            </div>
          </section>

          <section id="web-brief-evidence" className="scroll-mt-6 border-t border-border pt-7" aria-labelledby="web-brief-evidence-title">
            <div className="flex items-center gap-2 text-primary"><Quote className="size-4" /><h2 id="web-brief-evidence-title" className="text-xs font-semibold uppercase tracking-[0.14em]">证据与来源</h2></div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">只展示本轮实际保存的来源；正文中的引用关系和原文摘录需要一起核对。</p>
            {evidenceMap.length > 0 ? (
              <div className="mt-4 space-y-3">
                {evidenceMap.map((row) => <div key={row.section} className="border border-border bg-card px-4 py-3"><p className="text-xs font-semibold">{row.section}</p><div className="mt-2 flex flex-wrap gap-2">{row.citations.map((citation) => <a key={citation.href} href={citation.href} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-xs text-primary hover:underline"><span className="max-w-[260px] truncate">{citation.title}</span><ExternalLink className="size-3 shrink-0" /></a>)}</div></div>)}
              </div>
            ) : <p className="mt-4 border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">正文没有识别到可回链引用，不能仅凭来源数量判断结论已被支持。</p>}
            {sources.length > 0 ? (
              <>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {sources.slice(0, 8).map((source, index) => (
                    <article key={source.id} className="border border-border bg-card px-4 py-3">
                      <div className="flex items-start gap-2"><span className="font-mono text-[10px] text-tier-skim">{String(index + 1).padStart(2, '0')}</span><div className="min-w-0 flex-1">{source.href ? <a href={source.href} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-start gap-1 text-xs font-medium text-primary hover:underline"><span className="line-clamp-2">{source.title}</span><ArrowUpRight className="mt-0.5 size-3 shrink-0" /></a> : <p className="text-xs font-medium">{source.title}</p>}{source.snippet ? <p className="mt-2 line-clamp-4 text-xs leading-5 text-muted-foreground">{cleanEvidenceSnippet(source.snippet, 360)}</p> : null}<p className="mt-2 text-[10px] text-muted-foreground">{source.capturedAt ? `抓取于 ${formatDate(source.capturedAt)}` : '抓取时间未知'}</p></div></div>
                    </article>
                  ))}
                </div>
                {sources.length > 8 ? <p className="mt-3 text-center text-[11px] text-muted-foreground">已展示前 8 条来源；其余 {sources.length - 8} 条资料仍保留在研究过程的资料账本中。</p> : null}
              </>
            ) : <p className="mt-4 text-sm text-muted-foreground">本轮没有保存可核对来源。</p>}
          </section>
        </div>

        <aside className="hidden lg:block" aria-label="网页简报侧栏">
          <div className="sticky top-5 space-y-5 border-l border-border pl-5 print:hidden">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">On this page</p>
            <ol className="space-y-3 text-xs leading-5 text-muted-foreground">
              <li><a href="#web-brief-summary" className="hover:text-primary">01 · 一页判断</a></li>
              <li><a href="#web-brief-findings" className="hover:text-primary">02 · 关键发现</a></li>
              <li><a href="#web-brief-report" className="hover:text-primary">03 · 详细报告</a></li>
              <li><a href="#web-brief-evidence" className="hover:text-primary">04 · 证据与来源</a></li>
            </ol>
            <div className="border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
              <p className="font-medium text-foreground">阅读原则</p>
              <p className="mt-1">结论、证据和不确定性放在同一条阅读路径里，先看判断，再回到原文。</p>
            </div>
          </div>
        </aside>
      </div>
    </article>
  );
}

function isMetaSection(heading: string): boolean {
  return /摘要|执行摘要|核心判断|结论|风险|局限|挑战|代价|注意|限制|行动|下一步|建议|证据|来源|summary|conclusion|risk|action|source/iu.test(heading);
}

function isPromotedSection(heading: string): boolean {
  return /摘要|执行摘要|核心判断|结论|风险|局限|挑战|代价|注意|限制|行动|下一步|建议|验证|落地|证据|来源|参考|summary|conclusion|risk|action|source|reference/iu.test(heading);
}

function hasSectionContent(lines: string[]): boolean {
  return lines.some((line) => line.trim() && !/^[-*_]{3,}$/u.test(line.trim()));
}

/** Keep the first reading surface scannable while preserving the full report below. */
function compactBriefSummary(text: string | null): string | null {
  if (!text?.trim()) return null;
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const limit = 1200;
  const selected: string[] = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    if (selected.length > 0 && length + paragraph.length > limit) break;
    selected.push(paragraph);
    length += paragraph.length;
  }
  if (selected.length > 0) return selected.join('\n\n');
  return text.trim().slice(0, limit);
}

function sectionLead(lines: string[]): string {
  const text = lines
    .filter((line) => line.trim() && !/^\s*(?:[-*+]\s+|\d+[.)]\s+|\|)/u.test(line))
    .join(' ');
  return cleanEvidenceSnippet(text || lines.join(' '), 240) || '本节暂无可提取摘要。';
}

function ListBlock({ title, icon, items, tone }: { title: string; icon: ReactNode; items: string[]; tone: 'risk' | 'action' }) {
  return (
    <section className={cn('border px-4 py-4', tone === 'risk' ? 'border-warning-border bg-warning-bg' : 'border-status-succeeded-border bg-status-succeeded-bg')}>
      <div className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</div>
      <ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">{items.slice(0, 6).map((item) => <li key={item} className="flex gap-2"><span className={cn('mt-2 size-1.5 shrink-0 rounded-full', tone === 'risk' ? 'bg-tier-skim' : 'bg-primary')} />{item}</li>)}</ul>
    </section>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
