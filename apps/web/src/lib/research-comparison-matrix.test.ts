import { describe, expect, it } from 'vitest';
import { checkComparisonMatrix } from './research-comparison-matrix';

const marked = `# 对比

## 对比矩阵

| 方案 | 并发安全 | 吞吐 |
|---|---|---|
| A | 锁行。[S1] | 待实测 |
| B | 锁业务键。[S2] | 未知 |

## 下一步
`;

describe('checkComparisonMatrix', () => {
  it('accepts grounded and explicitly unknown cells', () => {
    expect(checkComparisonMatrix(marked)).toMatchObject({ present: true, rows: 2, columns: 2, unmarked: [] });
  });

  it('flags an assertion without a source or explicit gap', () => {
    const body = marked.replace('锁行。[S1]', '锁行，性能更好。');
    const check = checkComparisonMatrix(body);
    expect(check.unmarked).toHaveLength(1);
    expect(check.unmarked[0]).toMatchObject({ row: 'A', column: '并发安全' });
  });

  it('ignores tables outside the comparison section', () => {
    expect(checkComparisonMatrix('## 其他\n\n| A | B |\n|---|---|\n| 1 | 2 |')).toEqual({ present: false, rows: 0, columns: 0, unmarked: [] });
  });
});
