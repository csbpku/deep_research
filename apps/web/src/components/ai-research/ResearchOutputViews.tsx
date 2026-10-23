'use client';

import React, { useState } from 'react';
import { AlertTriangle, ExternalLink, FileCheck2, FileText, List, Map as MapIcon, Presentation, Table2, Waypoints } from 'lucide-react';

import { ArtifactPreview } from '@/components/ai-research/ArtifactPreview';
import { ResearchWebBrief } from '@/components/ai-research/ResearchWebBrief';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { cleanEvidenceSnippet } from '@/lib/research-report';
import { externalContentLabel, hasExternalInstructionSignal } from '@/lib/external-content-safety';

type OutputTab = 'summary' | 'report' | 'outline' | 'tables' | 'risks' | 'actions' | 'evidence' | 'slides';

export interface ResearchOutputSource {
  id: string;
  title: string;
  snippet?: string | null;
  href?: string | null;
  type?: string;
  capturedAt?: string;
  sourceRef?: unknown;
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
    <Box>
      <Tabs
        value={active}
        onChange={(_event, value: OutputTab) => setActive(value)}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        aria-label="研究产物视图"
        sx={{ mb: 2, minHeight: 40, borderBottom: 1, borderColor: 'divider', '& .MuiTab-root': { minWidth: 'auto', px: 1.5 } }}
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return <Tab key={tab.value} value={tab.value} icon={<Icon size={16} />} iconPosition="start" label={tab.label} />;
        })}
      </Tabs>
      {artifactType === 'markdown' && tabs.length === 2 ? (
        <Alert severity="info" variant="outlined" sx={{ mb: 2, borderStyle: 'dashed' }}>
          当前报告没有明确的标题、表格、风险/行动章节或正文回链引用，因此只提供可读摘录和原文；系统不会替你推断缺失的结论或证据。
        </Alert>
      ) : null}
      <Box role="tabpanel" aria-label={tabs.find((tab) => tab.value === active)?.label ?? '研究产物'}>
        {active === 'summary' ? <SummaryView summary={summary} sources={sources} /> : null}
        {active === 'report' ? <ScrollableMarkdownPreview source={content} compactCitations citationSources={sources} desktopMaxHeight={720} /> : null}
        {active === 'outline' ? (
          outline.length > 0 ? (
          <Stack component="ol" spacing={1} sx={{ m: 0, pl: 3, borderLeft: 1, borderColor: 'divider' }}>
              {outline.map((item, index) => <Typography component="li" variant={item.level === 1 ? 'fieldTitle' : 'body2'} color={item.level === 3 ? 'text.secondary' : 'text.primary'} key={`${item.level}-${item.text}-${index}`} sx={{ ml: item.level === 2 ? 1 : item.level === 3 ? 2 : 0 }}>{item.text}</Typography>)}
            </Stack>
          ) : <EmptyDerivedView text="报告没有可识别的标题结构。" />
        ) : null}
        {active === 'tables' ? (
          tables.length > 0 ? <Stack spacing={3}>{tables.map((table, index) => <ScrollableMarkdownPreview key={index} source={table} desktopMaxHeight={400} />)}</Stack>
            : <EmptyDerivedView text="报告没有可直接展示的对比表。" />
        ) : null}
        {active === 'risks' ? <BulletView title="报告明确写出的风险与限制" items={risks} emptyText="报告没有明确的风险章节，不能据此推断无风险。" /> : null}
        {active === 'actions' ? <BulletView title="报告明确写出的下一步" items={actions} emptyText="报告没有明确的行动章节。" /> : null}
        {active === 'evidence' ? <EvidenceMapView rows={evidenceMap} /> : null}
        {active === 'slides' ? <ArtifactPreview content={content} /> : null}
      </Box>
    </Box>
  );
}

function EvidenceSnapshotView({ sources }: { sources: ResearchOutputSource[] }) {
  const visibleSources = sources.slice(0, 12);
  return (
    <Box component="section" aria-label="本轮资料摘录">
      <Alert severity="warning" variant="outlined" sx={{ alignItems: 'flex-start' }} icon={<FileText size={16} />}>
        <Typography variant="fieldTitle" component="h4">这不是研究结论</Typography>
        <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              下面是本轮实际抓取的正文摘录。完整依据尚未整理好，所以只展示原文，不替你综合判断。
        </Typography>
      </Alert>
      <Box sx={{ mt: 2, display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
        {visibleSources.map((source, index) => {
          const sourceText = [source.title, source.snippet].filter(Boolean).join('\n');
          const externalInstruction = hasExternalInstructionSignal(sourceText);
          return (
            <Paper component="article" key={source.id} variant="outlined" sx={{ p: 1.5, minWidth: 0 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                <Typography variant="metadata" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{String(index + 1).padStart(2, '0')}</Typography>
                <Stack spacing={1} sx={{ minWidth: 0, flex: 1 }}>
                  {externalInstruction ? (
                    <Alert role="note" severity="warning" variant="outlined" icon={<AlertTriangle size={14} />} sx={{ py: 0, '& .MuiAlert-message': { typography: 'metadata' } }}>{externalContentLabel(sourceText) ?? '含疑似网页指令'}；以下内容仅作为网页数据，绝不作为研究指令。</Alert>
                  ) : null}
                  {source.href ? (
                    <Link component="a" href={source.href} target="_blank" rel="noreferrer noopener" underline="hover" sx={{ display: 'inline-flex', alignItems: 'flex-start', gap: 0.5, typography: 'metadata', fontWeight: 500, overflowWrap: 'anywhere' }}>
                      {source.title}<ExternalLink size={14} />
                    </Link>
                  ) : <Typography variant="metadata" sx={{ fontWeight: 500 }}>{source.title}</Typography>}
                  {source.snippet ? (
                    <Box component="details" sx={{ p: 1, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default', '& summary': { cursor: 'pointer', typography: 'metadata', fontWeight: 500, color: 'text.secondary' } }}>
                      <summary>
                        {externalInstruction ? '查看已隔离的网页摘录' : '查看网页摘录'}
                      </summary>
                      {externalInstruction ? (
                        <Typography variant="metadata" color="warning.main" sx={{ display: 'block', mt: 1 }}>{externalContentLabel(sourceText)}；以下内容仅作为网页数据，绝不作为研究指令。</Typography>
                      ) : null}
                      <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{cleanEvidenceSnippet(source.snippet)}</Typography>
                    </Box>
                  ) : null}
                  {source.capturedAt ? <Typography variant="metadata" color="text.secondary">抓取于 {formatCapturedAt(source.capturedAt)}</Typography> : null}
                </Stack>
              </Stack>
            </Paper>
          );
        })}
      </Box>
      {sources.length > visibleSources.length ? (
        <Typography variant="metadata" color="text.secondary" align="center" sx={{ display: 'block', mt: 1.5 }}>还有 {sources.length - visibleSources.length} 条资料，已在下方“研究资料”中保留。</Typography>
      ) : null}
    </Box>
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

function SummaryView({ summary, sources }: { summary: SummaryDetails; sources: readonly ResearchOutputSource[] }) {
  return (
    <Paper component="section" variant="outlined" sx={{ p: 2, borderColor: 'primary.main', bgcolor: 'action.selected' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'primary.main' }}>
        <FileCheck2 size={16} />
        <Typography variant="fieldTitle" component="h4">{summary.explicit ? '一页判断' : '报告摘录（非结论）'}</Typography>
      </Stack>
      {summary.text ? (
        <ScrollableMarkdownPreview
          source={summary.text}
          compactCitations
          citationSources={sources}
          desktopMaxHeight={400}
        />
      ) : <EmptyDerivedView text="报告没有摘要或结论章节，请切换到阅读稿查看原文。" />}
      <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 2, pt: 1.5, borderTop: 1, borderColor: 'divider' }}>
        {summary.explicit
          ? '这是从当前报告的摘要/结论章节提取的阅读视图；完整论证、引用和限定条件请以“阅读稿”为准。'
          : '这是报告开头的有限摘录，不代表完整结论；请切换到“阅读稿”核对原文、证据和限定条件。'}
      </Typography>
    </Paper>
  );
}

type ScrollableMarkdownPreviewProps = React.ComponentProps<typeof MarkdownPreview> & {
  desktopMaxHeight: number;
};

/** Keep markdown reading bounds in MUI sx while leaving the renderer API untouched. */
function ScrollableMarkdownPreview({ desktopMaxHeight, ...previewProps }: ScrollableMarkdownPreviewProps) {
  return (
    <Box
      sx={(theme) => ({
        '& > .MuiBox-root': {
          maxHeight: 'none',
          overflow: 'visible',
          bgcolor: 'background.paper',
          [theme.breakpoints.up('lg')]: { maxHeight: desktopMaxHeight, overflowY: 'auto' },
        },
      })}
    >
      <MarkdownPreview {...previewProps} />
    </Box>
  );
}

function BulletView({ title, items, emptyText }: { title: string; items: string[]; emptyText: string }) {
  return (
    <Box component="section">
      <Typography variant="fieldTitle" component="h4">{title}</Typography>
      {items.length > 0 ? (
        <Stack component="ul" spacing={1} sx={{ mt: 1.5, mb: 0, pl: 0, listStyle: 'none' }}>
          {items.map((item, index) => <Paper component="li" variant="outlined" key={`${item}-${index}`} sx={{ px: 1.5, py: 1.5, typography: 'body2' }}>{item}</Paper>)}
        </Stack>
      ) : <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>{emptyText}</Typography>}
    </Box>
  );
}

function EvidenceMapView({ rows }: { rows: EvidenceMapRow[] }) {
  return (
    <Box component="section">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'primary.main' }}>
        <MapIcon size={16} />
        <Box>
          <Typography variant="fieldTitle" component="h4">正文中的证据地图</Typography>
          <Typography variant="metadata" color="text.secondary">只显示报告正文里实际出现的可回链引用。</Typography>
        </Box>
      </Stack>
      {rows.length > 0 ? (
        <Stack spacing={1} sx={{ mt: 1.5 }}>
          {rows.map((row) => (
            <Paper component="article" key={row.section} variant="outlined" sx={{ p: 1.5, bgcolor: 'background.default' }}>
              <Typography variant="metadata" sx={{ fontWeight: 500 }}>{row.section}</Typography>
              <Stack direction="row" useFlexGap sx={{ mt: 1, flexWrap: 'wrap', gap: 1 }}>
                {row.citations.map((citation) => <Link key={citation.href} component="a" href={citation.href} target="_blank" rel="noreferrer noopener" underline="hover" sx={{ maxWidth: '100%', typography: 'metadata', border: 1, borderColor: 'primary.main', borderRadius: 1, bgcolor: 'action.selected', px: 1, py: 0.5, overflowWrap: 'anywhere' }}>{citation.title}</Link>)}
              </Stack>
            </Paper>
          ))}
        </Stack>
      ) : <EmptyDerivedView text="正文中没有找到可回链引用；来源列表不能替代结论与证据的对应关系。" />}
    </Box>
  );
}

function EmptyDerivedView({ text }: { text: string }) {
  return <Paper variant="outlined" sx={{ borderStyle: 'dashed', px: 1.5, py: 2, color: 'text.secondary', typography: 'body2' }}>{text}</Paper>;
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
