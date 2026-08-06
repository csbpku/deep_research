export const MARKDOWN_COMMANDS = [
  { key: 'heading', label: '标题', hint: '## 小节标题', insert: '## 小节标题' },
  { key: 'bullet', label: '列表', hint: '- 列表项', insert: '- 列表项' },
  { key: 'todo', label: '任务清单', hint: '- [ ] 待办事项', insert: '- [ ] 待办事项' },
  { key: 'quote', label: '引用块', hint: '> 引用内容', insert: '> 引用内容' },
  { key: 'table', label: '对比表', hint: 'Markdown 表格', insert: '| 维度 | 结论 | 证据 |\n| --- | --- | --- |\n| 示例 | 待填写 | 待补充 |' },
  { key: 'callout', label: '提示块', hint: '> [!NOTE] 提示', insert: '> [!NOTE] 提示内容' },
  { key: 'code', label: '代码块', hint: '```\n代码\n```', insert: '```\n代码\n```' },
  { key: 'source', label: '来源引用', hint: '[^source-1]', insert: '[^source-1]' },
] as const;

export type MarkdownCommand = (typeof MARKDOWN_COMMANDS)[number];

export function commandQuery(value: string, caret: number): string | null {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  const before = value.slice(lineStart, caret);
  if (!/^\s*\/[^\s]*$/u.test(before)) return null;
  return before.trim().slice(1).toLowerCase();
}

export function matchingCommands(query: string): MarkdownCommand[] {
  return MARKDOWN_COMMANDS.filter((command) => command.key.startsWith(query) || command.label.includes(query));
}
