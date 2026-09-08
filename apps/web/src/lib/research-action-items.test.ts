import { describe, expect, it } from 'vitest';

import { formatResearchActionItems, parseResearchActionItems } from './research-action-items';

describe('research action item contract', () => {
  it('parses the structured follow-up output without inventing missing fields', () => {
    const items = parseResearchActionItems([
      '## 行动项 1：建立小规模评测集',
      '- 负责人：平台组',
      '- 优先级：P1',
      '- 待验证假设：十条真实问题足以暴露召回差异',
      '- 完成条件：完成两套检索方案的同口径评测',
      '- 依据：报告中的证据缺口',
      '',
      '## 行动项 2：确认成本边界',
      '- 优先级：P2',
      '- 待验证假设：增量索引成本可接受',
      '- 完成条件：记录每次查询与构建成本',
      '- 依据：未明确',
    ].join('\n'));

    expect(items).toEqual([
      {
        title: '建立小规模评测集',
        owner: '平台组',
        priority: 'P1',
        hypothesis: '十条真实问题足以暴露召回差异',
        completionCriteria: '完成两套检索方案的同口径评测',
        basis: '报告中的证据缺口',
      },
      {
        title: '确认成本边界',
        owner: null,
        priority: 'P2',
        hypothesis: '增量索引成本可接受',
        completionCriteria: '记录每次查询与构建成本',
        basis: '未明确',
      },
    ]);
  });

  it('formats an action list for copy without changing the saved transcript', () => {
    const items = parseResearchActionItems([
      '### 1. 验证来源覆盖',
      '- 负责人：待指定',
      '- 优先级：P0',
      '- 待验证假设：官方文档覆盖足够',
      '- 完成条件：列出缺口',
      '- 依据：证据账本',
    ].join('\n'));
    expect(formatResearchActionItems(items)).toContain('验证来源覆盖');
    expect(formatResearchActionItems(items)).toContain('负责人：待指定');
  });

  it('does not turn arbitrary headings into action items', () => {
    expect(parseResearchActionItems('# 结论\n\n## 风险\n\n没有行动项。')).toEqual([]);
  });
});

