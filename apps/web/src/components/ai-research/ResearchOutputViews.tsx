'use client';

import React, { useState } from 'react';
import { AlertTriangle, ExternalLink, FileCheck2, FileText, List, Map as MapIcon, Presentation, Table2, Waypoints } from 'lucide-react';

import { ArtifactPreview } from '@/components/ai-research/ArtifactPreview';
import { ResearchWebBrief } from '@/components/ai-research/ResearchWebBrief';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { cleanEvidenceSnippet } from '@/lib/research-report';

type OutputTab = 'summary' | 'report' | 'outline' | 'tables' | 'risks' | 'actions' | 'evidence' | 'slides';

export interface ResearchOutputSource {
  id: string;
  title: string;
  snippet?: string | null;
  href?: string | null;
  type?: string;
  capturedAt?: string;
}

export interface ResearchOutputViewsProps {
  content: string;
  artifactType: 'markdown' | 'slides';
  sources?: ResearchOutputSource[];
  evidenceOnly?: boolean;
  presentationType?: 'standard' | 'web';
  reviewStatus?: string | null;
  showQualityStatus?: boolean;
}

/**
 * 结果视图只从同一份 artifact 派生，不重新请求模型。
 *
 * 摘要、风险、行动项和证据地图是阅读视图，不是四份互相独立的答案。
 * 解析不到内容时明确展示“没有识别到”，不凭空补全。
 */
export function ResearchOutputViews({ content, artifactType, sources = [], evidenceOnly = false, presentationType = 'standard', reviewStatus = null, showQualityStatus = true }: ResearchOutputViewsProps) {
  const [active, setActive] = useState<OutputTab>(artifactType === 'slides' ? 'slides' : 'summary');
  if (presentationType === 'web' && artifactType === 'markdown' && !evidenceOnly) {
    return <ResearchWebBrief content={content} sources={sources} reviewStatus={reviewStatus} showQualityStatus={showQualityStatus} />;
  }
  if (evidenceOnly && artifactType === 'markdown' && sources.length > 0) {
    return <EvidenceSnapshotView sources={sources} />;
  }
  const summary = extractDecisionSummaryDetails(content);
  const outline = extractOutline(content);
  const tables = extractTables(content);
  const risks = extractBulletsFromSections(content, /风险|局限|挑战|代价|注意|限制|risk|limitation/iu);
  const actions = extractBulletsFromSections(content, /行动|下一步|建议|验证|落地|action|recommendation|next/iu);
  const evidenceMap = extractEvidenceMap(content, sources);
  const tabs: Array<{ value: OutputTab; label: string; icon: typeof FileText }> = artifactType === 'slides'
    ? [{ value: 'slides', label: '按页预览', icon: Presentation }]
    : [
        { value: 'summary', label: '决策摘要', icon: FileCheck2 },
        { value: 'report', label: '阅读稿', icon: FileText },
        ...(outline.length > 0 ? [{ value: 'outline' as const, label: '结构大纲', icon: List }] : []),
        ...(tables.length > 0 ? [{ value: 'tables' as const, label: `对比表 · ${tables.length}`, icon: Table2 }] : []),
        ...(risks.length > 0 ? [{ value: 'risks' as const, label: `风险 · ${risks.length}`, icon: AlertTriangle }] : []),
        ...(actions.length > 0 ? [{ value: 'actions' as const, label: `行动 · ${actions.length}`, icon: Waypoints }] : []),
        ...(evidenceMap.length > 0 ? [{ value: 'evidence' as const, label: '证据地图', icon: MapIcon }] : []),
      ];

  return (
    <div>
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-border pb-px" role="tablist" aria-label="研究产物视图">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <Button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active === tab.value}
              variant="ghost"
              size="sm"
              onClick={() => setActive(tab.value)}
              className={cn('shrink-0 rounded-b-none border-b-2 border-transparent text-xs', active === tab.value && 'border-primary text-primary')}
            >
              <Icon className="size-3.5" />
              {tab.label}
            </Button>
          );
        })}
      </div>
      {artifactType === 'markdown' && tabs.length === 2 ? (
        <p className="mb-4 rounded-lg border border-dashed border-border px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          当前报告没有明确的标题、表格、风险/行动章节或正文回链引用，因此只提供可读摘录和原文；系统不会替你推断缺失的结论或证据。
        </p>
      ) : null}
      <div role="tabpanel" aria-label={tabs.find((tab) => tab.value === active)?.label ?? '研究产物'}>
        {active === 'summary' ? <SummaryView summary={summary} /> : null}
        {active === 'report' ? <MarkdownPreview source={content} className="max-h-none overflow-visible lg:max-h-[720px] lg:overflow-y-auto" /> : null}
        {active === 'outline' ? (
          outline.length > 0 ? (
            <ol className="space-y-2 border-l border-border pl-4 text-sm">
              {outline.map((item, index) => <li key={`${item.level}-${item.text}-${index}`} className={cn(item.level === 1 ? 'font-semibold' : item.level === 2 ? 'font-medium' : 'text-muted-foreground')}>{item.text}</li>)}
            </ol>
          ) : <EmptyDerivedView text="报告没有可识别的标题结构。" />
        ) : null}
        {active === 'tables' ? (
          tables.length > 0 ? <div className="space-y-6">{tables.map((table, index) => <MarkdownPreview key={index} source={table} className="max-h-none overflow-visible lg:max-h-[400px] lg:overflow-y-auto" />)}</div>
            : <EmptyDerivedView text="报告没有可直接展示的对比表。" />
        ) : null}
        {active === 'risks' ? <BulletView title="报告明确写出的风险与限制" items={risks} emptyText="报告没有明确的风险章节，不能据此推断无风险。" /> : null}
        {active === 'actions' ? <BulletView title="报告明确写出的下一步" items={actions} emptyText="报告没有明确的行动章节。" /> : null}
        {active === 'evidence' ? <EvidenceMapView rows={evidenceMap} /> : null}
        {active === 'slides' ? <ArtifactPreview content={content} /> : null}
      </div>
    </div>
  );
}

function EvidenceSnapshotView({ sources }: { sources: ResearchOutputSource[] }) {
  const visibleSources = sources.slice(0, 12);
  return (
    <section aria-label="本轮资料摘录">
      <div className="rounded-xl border border-warning-border/50 bg-warning-bg/25 p-4">
        <div className="flex items-start gap-2.5">
          <FileText className="mt-0.5 size-4 shrink-0 text-warning-fg" />
          <div>
            <h4 className="text-sm font-semibold text-foreground">这不是研究结论</h4>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              下面是本轮实际抓取的正文摘录。完整依据尚未整理好，所以只展示原文，不替你综合判断。
            </p>
          </div>
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {visibleSources.map((source, index) => (
          <article key={source.id} className="rounded-lg border border-border/80 bg-background px-3.5 py-3">
            <div className="flex items-start gap-2">
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
              <div className="min-w-0 flex-1">
                {source.href ? (
                  <a href={source.href} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-start gap-1 text-xs font-medium text-foreground hover:text-primary hover:underline">
                    <span className="line-clamp-2">{source.title}</span>
                    <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                  </a>
                ) : <p className="text-xs font-medium">{source.title}</p>}
                {source.snippet ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{cleanEvidenceSnippet(source.snippet)}</p> : null}
                {source.capturedAt ? <p className="mt-2 text-[10px] text-muted-foreground">抓取于 {formatCapturedAt(source.capturedAt)}</p> : null}
              </div>
            </div>
          </article>
        ))}
      </div>
      {sources.length > visibleSources.length ? (
        <p className="mt-3 text-center text-[11px] text-muted-foreground">还有 {sources.length - visibleSources.length} 条资料，已在下方“研究资料”中保留。</p>
      ) : null}
    </section>
  );
}

function formatCapturedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

export interface SummaryDetails {
  text: string | null;
  explicit: boolean;
}

function SummaryView({ summary }: { summary: SummaryDetails }) {
  return (
    <section className="rounded-xl border border-primary/20 bg-primary/[0.035] p-4">
      <div className="flex items-center gap-2">
        <FileCheck2 className="size-4 text-primary" />
        <h4 className="text-sm font-semibold">{summary.explicit ? '一页判断' : '报告摘录（非结论）'}</h4>
      </div>
      {summary.text ? <MarkdownPreview source={summary.text} className="max-h-none overflow-visible lg:max-h-[400px] lg:overflow-y-auto" /> : <EmptyDerivedView text="报告没有摘要或结论章节，请切换到阅读稿查看原文。" />}
      <p className="mt-4 border-t border-primary/10 pt-3 text-[11px] leading-5 text-muted-foreground">
        {summary.explicit
          ? '这是从当前报告的摘要/结论章节提取的阅读视图；完整论证、引用和限定条件请以“阅读稿”为准。'
          : '这是报告开头的有限摘录，不代表完整结论；请切换到“阅读稿”核对原文、证据和限定条件。'}
      </p>
    </section>
  );
}

function BulletView({ title, items, emptyText }: { title: string; items: string[]; emptyText: string }) {
  return (
    <section>
      <h4 className="text-sm font-semibold">{title}</h4>
      {items.length > 0 ? (
        <ul className="mt-3 space-y-2 text-sm leading-6">
          {items.map((item, index) => <li key={`${item}-${index}`} className="flex gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />{item}</li>)}
        </ul>
      ) : <p className="mt-3 text-sm text-muted-foreground">{emptyText}</p>}
    </section>
  );
}

function EvidenceMapView({ rows }: { rows: EvidenceMapRow[] }) {
  return (
    <section>
      <div className="flex items-center gap-2">
        <MapIcon className="size-4 text-primary" />
        <div>
          <h4 className="text-sm font-semibold">正文中的证据地图</h4>
          <p className="text-xs text-muted-foreground">只显示报告正文里实际出现的可回链引用。</p>
        </div>
      </div>
      {rows.length > 0 ? (
        <div className="mt-3 space-y-2">
          {rows.map((row) => (
            <article key={row.section} className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5">
              <h5 className="text-xs font-medium text-foreground">{row.section}</h5>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {row.citations.map((citation) => <a key={citation.href} href={citation.href} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/20 bg-primary/[0.04] px-2 py-1 text-[11px] text-primary hover:underline"><span className="max-w-[260px] truncate">{citation.title}</span></a>)}
              </div>
            </article>
          ))}
        </div>
      ) : <EmptyDerivedView text="正文中没有找到可回链引用；来源列表不能替代结论与证据的对应关系。" />}
    </section>
  );
}

function EmptyDerivedView({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">{text}</p>;
}

interface ReportSection {
  level: number;
  heading: string;
  body: string[];
}

export function extractSections(content: string): ReportSection[] {
  const sections: ReportSection[] = [];
  let current: ReportSection | null = null;
  for (const line of content.split(/\r?\n/u)) {
    const match = /^(#{1,3})\s+(.+?)\s*#*$/u.exec(line.trim());
    if (match) {
      if (current) sections.push(current);
      current = { level: match[1].length, heading: match[2].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

export function extractDecisionSummary(content: string): string | null {
  return extractDecisionSummaryDetails(content).text;
}

export function extractDecisionSummaryDetails(content: string): SummaryDetails {
  const sections = extractSections(content);
  const preferred = sections.find((section) => /摘要|执行摘要|核心判断|结论|recommendation|summary|conclusion/iu.test(section.heading));
  // 没有明确摘要/结论时，只展示报告的开头摘录，而不是把整篇报告
  // 塞进“一页判断”。没有证据支持时，视图不应制造一个看似完整的结论。
  const fallback = sections.find((section) => section.body.some((line) => line.trim()))?.body
    ?? content.split(/\r?\n/u);
  const body = preferred?.body ?? fallback;
  const cleanedLines = body
    .map((line) => line.replace(/^\s*[-*+]\s+/u, '').trim())
    .filter((line) => line && !/^[-*_]{3,}$/u.test(line))
  const cleaned = cleanedLines
    .slice(0, preferred ? 24 : 8)
    .join('\n')
    .trim();
  return {
    text: cleaned ? cleaned.slice(0, preferred ? 2400 : 960) : null,
    explicit: !!preferred,
  };
}

export function extractOutline(content: string): Array<{ level: number; text: string }> {
  return extractSections(content).map((section) => ({ level: section.level, text: section.heading }));
}

export function extractTables(content: string): string[] {
  const lines = content.split(/\r?\n/u);
  const tables: string[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].includes('|') || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(lines[index + 1])) continue;
    const block = [lines[index], lines[index + 1]];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim() !== '') {
      block.push(lines[cursor]);
      cursor += 1;
    }
    tables.push(block.join('\n'));
    index = cursor - 1;
  }
  return tables;
}

export function extractBulletsFromSections(content: string, headingPattern: RegExp): string[] {
  const results: string[] = [];
  for (const section of extractSections(content)) {
    if (!headingPattern.test(section.heading)) continue;
    for (const line of section.body) {
      const item = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/u.exec(line)?.[1]?.trim();
      if (item) results.push(item.replace(/[*_`]/gu, '').trim());
    }
  }
  return Array.from(new Set(results)).slice(0, 24);
}

interface EvidenceMapCitation {
  title: string;
  href: string;
}

interface EvidenceMapRow {
  section: string;
  citations: EvidenceMapCitation[];
}

export function extractEvidenceMap(content: string, sources: ResearchOutputSource[] = []): EvidenceMapRow[] {
  const sourceByHref = new Map(sources.filter((source) => source.href).map((source) => [normalizeHref(source.href as string), source]));
  const rows: EvidenceMapRow[] = [];
  for (const section of extractSections(content)) {
    const citations: EvidenceMapCitation[] = [];
    const links = section.body.join('\n').matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/giu);
    for (const match of links) {
      const href = match[2];
      const known = sourceByHref.get(normalizeHref(href));
      const citation = { href, title: known?.title ?? (match[1].trim() || href) };
      if (!citations.some((item) => normalizeHref(item.href) === normalizeHref(citation.href))) citations.push(citation);
    }
    if (citations.length > 0) rows.push({ section: section.heading, citations });
  }
  return rows;
}

function normalizeHref(value: string): string {
  return value.replace(/\/$/u, '').toLowerCase();
}
