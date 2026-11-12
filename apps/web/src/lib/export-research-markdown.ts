import {
  researchReviewDisclosureMessages,
  type ResearchReviewReaderItem,
  type ResearchReviewReaderSummary,
  type ResearchReviewVerification,
} from './research-review-reader';

export interface ExportResearchMarkdownInput {
  title: string;
  background: string | null;
  conclusion: string | null;
  risks: string | null;
  body: string;
  tags: string[];
  publishedAt: string | null;
  reviewDisclosure?: ResearchReviewReaderItem[];
  reviewDisclosureSummary?: ResearchReviewReaderSummary | null;
  reviewVerification?: ResearchReviewVerification;
}

function section(heading: string, value: string | null): string[] {
  const text = value?.trim();
  return text ? [`## ${heading}`, '', text, ''] : [];
}

export function buildResearchMarkdown(input: ExportResearchMarkdownInput): string {
  const lines = [`# ${input.title.trim()}`, ''];
  if (input.publishedAt) {
    lines.push(`> 发布：${new Date(input.publishedAt).toLocaleString('zh-CN')}`, '');
  }
  if (input.tags.length > 0) {
    lines.push(`> 标签：${input.tags.join('、')}`, '');
  }
  if (input.reviewVerification || input.reviewDisclosureSummary || input.reviewDisclosure?.length) {
    const labels = { verified: '已核验', disclosed: '带披露发布', conflicted: '核验存在冲突', unverified: '尚未完成核验' };
    lines.push('## 核验与披露', '');
    if (input.reviewVerification) lines.push(`> ${labels[input.reviewVerification]}`, '');
    if (input.reviewDisclosureSummary) {
      lines.push(...researchReviewDisclosureMessages(input.reviewDisclosureSummary).map((message) => `> ${message}`), '');
    }
    for (const item of input.reviewDisclosure ?? []) {
      lines.push(`- ${item.claim}`, `  - ${item.label}${item.reason ? `；作者理由：${item.reason}` : ''}`);
    }
    lines.push('');
  }
  lines.push(
    ...section('背景', input.background),
    ...section('结论', input.conclusion),
    ...section('风险与待验证', input.risks),
    '## 正文',
    '',
    input.body.trim(),
    '',
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

export function researchMarkdownFilename(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${safe || 'research'}.md`;
}
