import { describe, expect, it } from 'vitest';
import { parseIntCoverage } from './research-intent-coverage';

const sample = `## 一句话回答

内容。

## 覆盖检查

| 必答问题 | 状态 | 依据或缺口 |
|---|---|---|
| 核心机制是什么？ | 有证据 | 官方文档 [S1](https://example.com/doc) |
| 适用边界是什么？ | 部分覆盖 | 只覆盖了事务隔离级别 |
| 失败模式是什么？ | 未知 | 本轮未确认 |

## 自检

完成标准：已满足。
`;

describe('parseIntentCoverage', () => {
  it('parses the coverage table and normalises statuses', () => {
    const coverage = parseIntCoverage(sample);
    expect(coverage?.rows).toHaveLength(3);
    expect(coverage?.counts).toEqual({ evidence: 1, partial: 1, unknown: 1, conflict: 0 });
    expect(coverage?.rows[1].question).toBe('适用边界是什么？');
  });

  it('downgrades a self-declared evidence row with a caveat', () => {
    const body = `## 覆盖检查\n\n| 必答问题 | 状态 | 依据 |\n|---|---|---|\n| Q1 | 有证据 | 仅覆盖官方文档，源码尚未核验 |\n`;
    expect(parseIntCoverage(body)?.rows[0].status).toBe('partial');
  });

  it('returns null when the section is absent', () => {
    expect(parseIntCoverage('## 一句话回答\n\n没有覆盖表。')).toBeNull();
  });

  it('ignores tables outside the coverage section', () => {
    const body = `## 对比矩阵\n\n| 项 | 状态 |\n|---|---|\n| A | 未知 |\n\n## 覆盖检查\n\n| 必答问题 | 状态 | 依据 |\n|---|---|---|\n| Q1 | 有证据 | [S1] |\n`;
    const coverage = parseIntCoverage(body);
    expect(coverage?.rows).toHaveLength(1);
    expect(coverage?.counts.evidence).toBe(1);
  });
});
