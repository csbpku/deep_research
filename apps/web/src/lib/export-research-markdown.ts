export interface ExportResearchMarkdownInput {
  title: string;
  background: string | null;
  conclusion: string | null;
  risks: string | null;
  body: string;
  tags: string[];
  publishedAt: string | null;
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
