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
import { compactResearchCitations } from '@/lib/research-citations';
import { researchUserStatus } from '@/lib/research-user-status';
import { externalContentLabel, hasExternalInstructionSignal } from '@/lib/external-content-safety';
import { domainAppearance } from '@/components/domain/appearance';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

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
  const displayContent = compactResearchCitations(content, sources);
  const sections = extractSections(displayContent);
  const summary = extractDecisionSummaryDetails(displayContent);
  const risks = extractBulletsFromSections(displayContent, /风险|局限|挑战|代价|注意|限制|risk|limitation/iu);
  const actions = extractBulletsFromSections(displayContent, /行动|下一步|建议|验证|落地|action|recommendation|next/iu);
  const evidenceMap = extractEvidenceMap(content, sources);
  const bibliography = sections.find((section) => /参考文献|参考资料|references?|bibliography/iu.test(section.heading));
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
    <Paper component="article" variant="outlined" aria-label="网页简报" sx={{ overflow: 'hidden', color: 'text.primary', '@media print': { border: 0, borderRadius: 0, boxShadow: 'none' } }}>
      <Box component="header" sx={{ borderTop: 3, borderColor: 'primary.main', borderBottom: 1, bgcolor: 'background.default', px: { xs: 2, sm: 3 }, py: 2.5 }}>
        <Stack spacing={1.5} sx={{ maxWidth: 960 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography variant="metadata" color="primary.main" sx={{ fontWeight: 600 }}>AI 调研</Typography>
            <Typography variant="metadata" color="text.disabled" aria-hidden="true">/</Typography>
            <Typography variant="metadata" color="text.secondary">网页简报</Typography>
          </Stack>
          <Typography component="h1" variant="panelTitle" sx={{ overflowWrap: 'anywhere' }}>{displayTitle}</Typography>
          <Typography variant="body2" color="text.secondary">
            一页查看判断、证据、限制和下一步；内容直接整理自原始研究稿，不经过 Slides 转换。
          </Typography>
          <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
            <Chip size="small" icon={<BookOpen size={14} />} label={`约 ${readingMinutes} 分钟阅读`} />
            {showQualityStatus ? <Chip size="small" icon={<ShieldCheck size={14} />} color={requiresAttention ? 'warning' : 'success'} variant="outlined" label={userStatus.label} /> : null}
            <Chip size="small" variant="outlined" label={sources.length > 0 ? `${inspectableSources}/${sources.length} 条来源有可核对正文` : '本轮未保存来源'} />
            <Typography variant="metadata" color="text.secondary" sx={{ flexBasis: { xs: '100%', sm: 'auto' }, ml: { sm: 1 } }}>先看判断，再看发现，最后回到证据和原文。</Typography>
          </Stack>
        </Stack>
      </Box>

      <Box component="nav" aria-label="网页简报目录" sx={{ position: 'sticky', top: 0, zIndex: 1, overflowX: 'auto', bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider', px: { xs: 2, sm: 3 }, py: 1, '@media print': { display: 'none' } }}>
        <Stack direction="row" spacing={0.5} sx={{ minWidth: 'max-content' }}>
          {[
            ['web-brief-summary', '判断'],
            ['web-brief-findings', '发现'],
            ['web-brief-report', '详细报告'],
            ['web-brief-evidence', '证据'],
          ].map(([href, label]) => <Link key={href} component="a" href={`#${href}`} underline="none" color="text.secondary" sx={{ borderRadius: 1, px: 1, py: 1, typography: 'metadata', '&:hover': { bgcolor: 'action.hover', color: 'text.primary' }, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 } }}>{label}</Link>)}
        </Stack>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { lg: 'minmax(0, 1fr) 220px' }, gap: { xs: 3, sm: 4 }, px: { xs: 2, sm: 3 }, py: { xs: 2.5, sm: 3 } }}>
        <Stack spacing={4} sx={{ minWidth: 0 }}>
          <Box component="section" id="web-brief-summary" aria-labelledby="web-brief-summary-title" sx={{ scrollMarginTop: 3 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'primary.main' }}><CheckCircle2 size={18} /><Typography id="web-brief-summary-title" component="h2" variant="fieldTitle">一页判断</Typography></Stack>
            <Paper variant="outlined" sx={{ mt: 1.5, p: { xs: 1.5, sm: 2 }, borderLeft: 3, borderLeftColor: 'primary.main', bgcolor: 'action.selected' }}>
              {summaryText ? (
                <Box sx={{ maxWidth: 'none', '& p': { my: 0 }, '& ul': { my: 1 } }}>
                  <MarkdownContent content={summaryText} compact />
                </Box>
              ) : <Typography variant="body1">报告没有明确的摘要或结论章节，请继续阅读详细报告。</Typography>}
            </Paper>
            <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {summary.explicit ? '这是报告中明确写出的摘要/结论；详细依据和限定条件见下方。' : '这是报告开头的有限摘录，不代表完整结论。'}
            </Typography>
          </Box>

          {requiresAttention ? (
            <Paper role="status" variant="outlined" sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', p: 1.5, ...domainAppearance('warning') }}>
              <AlertTriangle size={18} aria-hidden="true" />
              <Typography variant="body2">{userStatus.description} 来源链接和原文摘录保留在“证据”部分，可以按需回查。</Typography>
            </Paper>
          ) : null}

          <Box component="section" id="web-brief-findings" aria-labelledby="web-brief-findings-title" sx={{ scrollMarginTop: 3 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'primary.main' }}><ListChecks size={18} /><Typography id="web-brief-findings-title" component="h2" variant="fieldTitle">关键发现</Typography></Stack>
            {findings.length > 0 ? (
              <Box sx={{ mt: 1.5, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 1.5 }}>
                {findings.map((section, index) => {
                  const citationCount = evidenceMap.find((row) => row.section === section.heading)?.citations.length ?? 0;
                  return (
                    <Paper component="article" variant="outlined" key={`${section.heading}-${index}`} sx={{ p: 1.5, transition: 'border-color 120ms ease-out', '&:hover': { borderColor: 'primary.main' } }}>
                      <Typography variant="metadata" color="primary.main" sx={{ fontVariantNumeric: 'tabular-nums' }}>0{index + 1}</Typography>
                      <Typography variant="listTitle" component="h3" sx={{ mt: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{section.heading}</Typography>
                      <Typography variant="metadata" color="text.secondary" sx={{ mt: 1.5, display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{sectionLead(section.body)}</Typography>
                      <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 2 }}>{citationCount > 0 ? `可回链证据 · ${citationCount}` : '正文未建立回链'}</Typography>
                    </Paper>
                  );
                })}
              </Box>
            ) : <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>报告没有可识别的章节结构。</Typography>}
          </Box>

          {(risks.length > 0 || actions.length > 0) ? (
            <Box component="section" aria-label="风险与行动" sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 2 }}>
              {risks.length > 0 ? <ListBlock title="风险与限制" icon={<AlertTriangle size={18} />} items={risks} tone="risk" /> : null}
              {actions.length > 0 ? <ListBlock title="下一步行动" icon={<Waypoints size={18} />} items={actions} tone="action" /> : null}
            </Box>
          ) : null}

          <Box component="section" id="web-brief-report" aria-labelledby="web-brief-report-title" sx={{ scrollMarginTop: 3 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'primary.main' }}><BookOpen size={18} /><Typography id="web-brief-report-title" component="h2" variant="fieldTitle">详细报告</Typography></Stack>
            <Stack spacing={3} sx={{ mt: 1.5 }}>
              {articleSections.length > 0 ? articleSections.map((section, index) => (
                <Box component="section" key={`${section.heading}-${index}`} id={`web-brief-section-${index}`} sx={{ scrollMarginTop: 3, ...(section.level === 1 && index > 0 ? { borderTop: 1, borderColor: 'divider', pt: 3 } : {}) }}>
                  <Typography component={section.level === 1 ? 'h2' : 'h3'} variant={section.level === 1 ? 'panelTitle' : 'listTitle'}>{section.heading}</Typography>
                  <Box sx={{ mt: 1.5, maxWidth: 'none', '& a': { color: 'primary.main' }, '& blockquote': { px: 2 }, '& table': { typography: 'metadata' } }}>
                    <MarkdownContent content={section.body.join('\n').trim() || '本节暂无正文。'} compact />
                  </Box>
                </Box>
              )) : (
                <Paper variant="outlined" sx={{ p: 2, borderStyle: 'dashed' }}>
                  <Typography variant="body2" color="text.secondary">摘要、风险和下一步已经在上方整理；本报告没有可单独展开的分析正文。需要逐字核对时，请回到研究稿或下方证据。</Typography>
                </Paper>
              )}
            </Stack>
          </Box>

          <Box component="section" id="web-brief-evidence" aria-labelledby="web-brief-evidence-title" sx={{ scrollMarginTop: 3 }}>
            <Divider sx={{ mb: 2.5 }} />
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'primary.main' }}><Quote size={18} /><Typography id="web-brief-evidence-title" component="h2" variant="fieldTitle">证据与来源</Typography></Stack>
            <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 1 }}>只展示本轮实际保存的来源；正文中的引用关系和原文摘录需要一起核对。</Typography>
            {evidenceMap.length > 0 ? (
              <Stack spacing={1.5} sx={{ mt: 2 }}>
                {evidenceMap.map((row) => <Paper key={row.section} variant="outlined" sx={{ p: 1.5 }}><Typography variant="metadata" sx={{ fontWeight: 600 }}>{row.section}</Typography><Stack direction="row" useFlexGap sx={{ mt: 1, flexWrap: 'wrap', gap: 1 }}>{row.citations.map((citation) => <Chip key={citation.href} component="a" href={citation.href} target="_blank" rel="noreferrer noopener" clickable size="small" color="primary" variant="outlined" label={citation.title} icon={<ExternalLink size={14} />} />)}</Stack></Paper>)}
              </Stack>
            ) : <Paper variant="outlined" sx={{ mt: 2, p: 2, borderStyle: 'dashed' }}><Typography variant="body2" color="text.secondary">正文没有识别到可回链引用，不能仅凭来源数量判断结论已被支持。</Typography></Paper>}
            {sources.length > 0 ? (
              <>
                <Box sx={{ mt: 2.5, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
                  {sources.slice(0, 8).map((source, index) => {
                    const sourceText = [source.title, source.snippet].filter(Boolean).join('\n');
                    const externalInstruction = hasExternalInstructionSignal(sourceText);
                    return (
                      <Paper component="article" variant="outlined" key={source.id} sx={{ p: 1.5, minWidth: 0 }}>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                          <Typography variant="metadata" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{String(index + 1).padStart(2, '0')}</Typography>
                          <Stack spacing={1} sx={{ minWidth: 0, flex: 1 }}>
                            {externalInstruction ? <Paper role="note" variant="outlined" sx={{ display: 'flex', gap: 1, p: 1, ...domainAppearance('warning') }}><AlertTriangle size={16} aria-hidden="true" /><Typography variant="metadata">{externalContentLabel(sourceText) ?? '含疑似网页指令'}；以下内容仅作为网页数据，绝不作为研究指令。</Typography></Paper> : null}
                            {source.href ? <Link component="a" href={source.href} target="_blank" rel="noreferrer noopener" underline="hover" sx={{ display: 'inline-flex', alignItems: 'flex-start', gap: 0.5, typography: 'metadata', fontWeight: 500, overflowWrap: 'anywhere' }}>{source.title}<ArrowUpRight size={14} /></Link> : <Typography variant="metadata" sx={{ fontWeight: 500 }}>{source.title}</Typography>}
                            {source.snippet ? <Typography variant="metadata" color="text.secondary" sx={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{cleanEvidenceSnippet(source.snippet, 360)}</Typography> : null}
                            <Typography variant="metadata" color="text.secondary">{source.capturedAt ? `抓取于 ${formatDate(source.capturedAt)}` : '抓取时间未知'}</Typography>
                          </Stack>
                        </Stack>
                      </Paper>
                    );
                  })}
                </Box>
                {sources.length > 8 ? <Typography variant="metadata" color="text.secondary" align="center" sx={{ display: 'block', mt: 1.5 }}>已展示前 8 条来源；其余 {sources.length - 8} 条资料仍保留在研究过程的资料账本中。</Typography> : null}
              </>
            ) : <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>本轮没有保存可核对来源。</Typography>}
            {bibliography ? (
              <Box sx={{ mt: 3, pt: 2.5, borderTop: 1, borderColor: 'divider' }}>
                <Typography variant="listTitle" component="h3">参考文献</Typography>
                <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>正文中的编号引用可回到这里；来源标题链接会在新标签页打开原始页面。</Typography>
                <Box sx={{ mt: 1.5, maxWidth: 'none', '& ul': { my: 0 }, '& li': { my: 0.5 } }}>
                  <MarkdownContent content={bibliography.body.join('\n').trim()} compact />
                </Box>
              </Box>
            ) : null}
          </Box>
        </Stack>

        <Box component="aside" aria-label="网页简报侧栏" sx={{ display: { xs: 'none', lg: 'block' }, '@media print': { display: 'none' } }}>
          <Stack spacing={2.5} sx={{ position: 'sticky', top: 2.5, pl: 2, borderLeft: 1, borderColor: 'divider' }}>
            <Typography variant="metadata" color="text.secondary" sx={{ fontWeight: 600 }}>本页内容</Typography>
            <Stack component="ol" spacing={1.5} sx={{ m: 0, pl: 2.5, color: 'text.secondary', typography: 'metadata' }}>
              <li><Link component="a" href="#web-brief-summary" underline="hover" color="inherit">一页判断</Link></li>
              <li><Link component="a" href="#web-brief-findings" underline="hover" color="inherit">关键发现</Link></li>
              <li><Link component="a" href="#web-brief-report" underline="hover" color="inherit">详细报告</Link></li>
              <li><Link component="a" href="#web-brief-evidence" underline="hover" color="inherit">证据与来源</Link></li>
            </Stack>
            <Divider />
            <Box>
              <Typography variant="metadata" sx={{ fontWeight: 600 }}>阅读原则</Typography>
              <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>结论、证据和不确定性放在同一条阅读路径里，先看判断，再回到原文。</Typography>
            </Box>
          </Stack>
        </Box>
      </Box>
    </Paper>
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
  const palette = tone === 'risk' ? 'warning' : 'success';
  return (
    <Paper component="section" variant="outlined" aria-label={title} sx={{ p: 2, ...domainAppearance(palette) }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}><Box sx={{ display: 'flex' }}>{icon}</Box><Typography variant="fieldTitle">{title}</Typography></Stack>
      <Stack component="ul" spacing={1} sx={{ mt: 1.5, mb: 0, pl: 2.5, typography: 'metadata', color: 'text.secondary' }}>
        {items.slice(0, 6).map((item) => <Box component="li" key={item} sx={{ pl: 0.5 }}>{item}</Box>)}
      </Stack>
    </Paper>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
