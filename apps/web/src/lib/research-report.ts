const PREAMBLE_SIGNALS = [
  'the user is asking',
  'let me analyze',
  'let me draft',
  'i should structure',
  'i need to write',
  "i'll need to",
  'since the sources',
  'plausible urls',
  'create reasonable citations',
] as const;

/**
 * Prefer the report's own heading for reader-facing labels.
 *
 * A job topic is often phrased as a full question, while the generated report
 * usually contains a shorter editorial title. Keeping this derived label at
 * the presentation boundary avoids changing the user's original question or
 * the persisted draft title.
 */
export function extractResearchTitle(content: string, fallback = 'AI 调研结果'): string {
  const heading = String(content ?? '').match(/^#\s+(?!#)(.+?)\s*#*\s*$/mu);
  const title = heading?.[1]
    ?.replace(/\[([^\]]+)\]\([^\s)]+\)/gu, '$1')
    .replace(/[*_`~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return title || fallback;
}

/**
 * A run may finish collecting sources while the report writer returns only an
 * evidence digest. That digest is useful for recovery, but it is not a
 * publishable report. Keep legacy jobs honest at the presentation boundary.
 */
export function isEvidenceOnlyResearchOutput(content: string | null | undefined): boolean {
  if (!content) return false;
  const normalized = content.replace(/\s+/gu, ' ');
  return (normalized.includes('报告模型没有返回可发布的研究正文')
    && normalized.includes('研究结论：待补写'))
    || normalized.includes('这是本轮实际抓取的资料快照，不是研究结论');
}

export interface EvidenceDigestSource {
  title: string;
  snippet?: string | null;
  href?: string | null;
  capturedAt?: string | null;
}

/** Clean provider/source Markdown for compact evidence UI without altering the stored body. */
export function cleanEvidenceSnippet(content: string, maxChars = 720): string {
  return String(content ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gmu, '')
    .replace(/[*_`~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxChars);
}

/**
 * Turn a saved evidence ledger into an inspectable, read-only checkpoint.
 *
 * This is deliberately not called a report: it contains no synthesized
 * conclusion and never fills gaps from model memory. It gives a user whose
 * writer/reviewer stopped late in the run something useful to inspect and a
 * grounded context for follow-up questions.
 */
export function buildEvidenceDigest(topic: string, sources: EvidenceDigestSource[]): string | null {
  const usable = sources.filter((source) => source.snippet?.trim());
  if (usable.length === 0) return null;
  const lines = [
    `# 资料快照：${topic}`,
    '',
    '> 这是本轮实际抓取的资料快照，不是研究结论。以下摘录可核对，但尚未经过结论综合或逐条事实审核。',
    '',
    `本轮保留 ${usable.length} 条可核对正文。请把它作为下一步研究输入，不要把来源数量当成结论质量。`,
    '',
    '## 已抓取资料',
    '',
  ];
  usable.forEach((source, index) => {
    const title = source.href ? `[${source.title}](${source.href})` : source.title;
    const capturedAt = source.capturedAt ? `（抓取于 ${formatEvidenceDate(source.capturedAt)}）` : '';
    lines.push(`### ${index + 1}. ${title}`);
    lines.push('');
    lines.push(`- 原文摘录${capturedAt}：${cleanEvidenceSnippet(source.snippet!)}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

/** Remove provider scratchpads and distrust links not captured by this run. */
export function cleanResearchReportForReader(content: string, sourceUrls: string[] = []): string {
  let cleaned = String(content ?? '').trim()
    .replace(/<think[^>]*>.*?<\/think[^>]*>/gis, '')
    .replace(/<think[^>]*>[\s\S]*$/iu, '')
    // Some providers emit `** conclusion**`; repair the delimiter so readers
    // see emphasis instead of raw asterisks. Keep this line-scoped to avoid
    // joining unrelated Markdown spans.
    .replace(/(^|[\s([{（【，,；;：:])\*\*[ \t]+([^*\n]+?)\*\*/gmu, (_match, prefix: string, value: string) => `${prefix}**${value.trim()}**`)
    .trim();

  const reportHeading = /^#\s+(?!Main title\s*[:：])\S.*$/gimu.exec(cleaned);
  if (reportHeading?.index !== undefined) {
    const prefix = cleaned.slice(0, reportHeading.index).toLowerCase();
    const signalCount = PREAMBLE_SIGNALS.filter((signal) => prefix.includes(signal)).length;
    if (signalCount >= 2) cleaned = cleaned.slice(reportHeading.index).trimStart();
  }

  const allowed = new Set(sourceUrls.map(normalizeUrl).filter(Boolean));
  return cleaned.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/giu,
    (original, label: string, href: string) => (
      allowed.has(normalizeUrl(href)) ? original : `${label}（链接未被本次来源验证）`
    ),
  );
}

const DEFAULT_SLIDE_LIMIT = 8;
const MIN_SLIDE_LIMIT = 3;
const MAX_SLIDE_LIMIT = 12;

interface SlideSection {
  heading: string;
  body: string;
}

/** Infer an explicit page constraint from the user's request or saved brief. */
export function extractSlideLimit(text: string, fallback = DEFAULT_SLIDE_LIMIT): number {
  const source = String(text ?? '');
  const match = source.match(/(?:不超过|以内|最多|至多)\s*(\d+)\s*(?:页|张)?/u)
    ?? source.match(/(\d+)\s*(?:页|张)\s*(?:以内|上限)/u)
    ?? source.match(/(?:max(?:imum)?|up\s+to)\s*(\d+)\s*(?:slides?|pages?)/iu);
  const value = Number(match?.[1]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_SLIDE_LIMIT, Math.max(MIN_SLIDE_LIMIT, Math.trunc(value)));
}

function splitMarkdownSections(content: string): SlideSection[] {
  const matches = Array.from(content.matchAll(/^#{1,3}\s+([^\n]+?)\s*#*\s*$/gmu));
  if (matches.length === 0) return [{ heading: '研究问题', body: content.trim() }];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    return {
      heading: match[1].trim(),
      body: content.slice(start, end).trim(),
    };
  });
}

function cleanSlideHeading(value: string): string {
  return value.replace(/^(?:Slide|幻灯片)\s*\d*\s*[:：-]?\s*/iu, '').trim();
}

function groupSections(sections: SlideSection[], limit: number): SlideSection[][] {
  const groupCount = Math.min(limit, sections.length);
  const baseSize = Math.floor(sections.length / groupCount);
  const remainder = sections.length % groupCount;
  const groups: SlideSection[][] = [];
  let cursor = 0;
  for (let index = 0; index < groupCount; index += 1) {
    const size = baseSize + (index < remainder ? 1 : 0);
    groups.push(sections.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}

/**
 * Keep the presentation boundary compatible with older jobs whose draft body
 * was persisted before the Slides renderer ran.
 *
 * Slides is currently a Markdown outline, not a .pptx file. The renderer has
 * one hard contract: preserve all report content while staying within the
 * user's explicit page limit. When there are more sections than pages, it
 * groups sections into the remaining pages instead of silently dropping the
 * tail as the old eight-section slice did.
 */
export function renderSlidesArtifactContent(content: string, title = 'AI 调研'): string {
  const normalized = String(content ?? '').replace(/\r\n?/gu, '\n').trim();
  const safeTitle = title.trim() || 'AI 调研';
  if (!normalized) return `## Slide 1: ${safeTitle}`;

  const slideLimit = extractSlideLimit(`${safeTitle}\n${normalized}`);
  const alreadyCanonical = /^#{1,2}\s+Slide\s+1\s*:/imu.test(normalized)
    && (normalized.match(/^#{1,2}\s+Slide\s+\d+\s*:/gmu)?.length ?? 0) <= slideLimit;
  if (alreadyCanonical) return normalized;

  const groups = groupSections(splitMarkdownSections(normalized), slideLimit);
  return groups.map((group, index) => {
    const first = group[0];
    const label = cleanSlideHeading(first.heading) || (index === 0 ? '研究问题' : `重点 ${index + 1}`);
    const bodyParts = group.map((section, sectionIndex) => {
      const body = section.body.trim();
      if (group.length === 1 || sectionIndex === 0) return body;
      return `### ${cleanSlideHeading(section.heading)}\n\n${body}`.trim();
    }).filter(Boolean);
    if (index === 0 && safeTitle !== label && !bodyParts.some((part) => part.includes(safeTitle))) {
      bodyParts.unshift(`主题：${safeTitle}`);
    }
    return `## Slide ${index + 1}: ${label}\n\n${bodyParts.join('\n\n') || '本页暂无正文。'}`;
  }).join('\n\n');
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    return url.toString().replace(/\/$/u, '');
  } catch {
    return '';
  }
}

function formatEvidenceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
