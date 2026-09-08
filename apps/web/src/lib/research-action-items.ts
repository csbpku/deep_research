export interface ResearchActionItem {
  title: string;
  owner: string | null;
  priority: string | null;
  hypothesis: string | null;
  completionCriteria: string | null;
  basis: string | null;
}

const ACTION_HEADING = /^#{2,4}\s+(?:(?:行动项\s*(?:\d+\s*)?|\d+\s*)[.)：:\-]\s*)(.+?)\s*#*$/u;
const FIELD_PATTERNS: Array<[keyof Omit<ResearchActionItem, 'title'>, RegExp]> = [
  ['owner', /^[-*+]?\s*(?:负责人|owner)\s*[：:]\s*(.+)$/iu],
  ['priority', /^[-*+]?\s*(?:优先级|priority)\s*[：:]\s*(.+)$/iu],
  ['hypothesis', /^[-*+]?\s*(?:待验证假设|验证假设|假设|hypothesis)\s*[：:]\s*(.+)$/iu],
  ['completionCriteria', /^[-*+]?\s*(?:完成条件|验收条件|完成标准|done criteria|completion criteria)\s*[：:]\s*(.+)$/iu],
  ['basis', /^[-*+]?\s*(?:依据|证据|来源|basis|evidence)\s*[：:]\s*(.+)$/iu],
];

function cleanValue(value: string): string {
  return value.replace(/^[-*+]\s+/u, '').replace(/[*_`]/gu, '').trim();
}

/**
 * Parse the intentionally small action-item contract returned by the
 * follow-up action intent. Unknown prose is ignored instead of being guessed
 * into an owner, priority, or completion criterion.
 */
export function parseResearchActionItems(content: string): ResearchActionItem[] {
  const lines = String(content ?? '').split(/\r?\n/u);
  const items: ResearchActionItem[] = [];
  let current: ResearchActionItem | null = null;

  const pushCurrent = () => {
    if (current) {
      current.title = current.title || `行动项 ${items.length + 1}`;
      items.push(current);
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = ACTION_HEADING.exec(line);
    if (heading && heading[1].trim()) {
      pushCurrent();
      current = {
        title: cleanValue(heading[1]),
        owner: null,
        priority: null,
        hypothesis: null,
        completionCriteria: null,
        basis: null,
      };
      continue;
    }
    if (!current) continue;
    for (const [field, pattern] of FIELD_PATTERNS) {
      const match = pattern.exec(line);
      if (match?.[1]?.trim()) {
        current[field] = cleanValue(match[1]);
        break;
      }
    }
  }
  pushCurrent();
  return items.slice(0, 24);
}

export function formatResearchActionItems(items: ResearchActionItem[]): string {
  return items.map((item, index) => [
    `${index + 1}. ${item.title}`,
    `负责人：${item.owner ?? '待指定'}`,
    `优先级：${item.priority ?? '待判断'}`,
    `待验证假设：${item.hypothesis ?? '未明确'}`,
    `完成条件：${item.completionCriteria ?? '未明确'}`,
    `依据：${item.basis ?? '未明确'}`,
  ].join('\n')).join('\n\n');
}
