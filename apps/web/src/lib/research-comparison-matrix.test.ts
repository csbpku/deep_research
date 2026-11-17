import { describe, expect, it } from 'vitest';
import { checkComparisonMatrix, findRecommendationLanguage, parseComparisonMatrix } from './research-comparison-matrix';

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

describe('parseComparisonMatrix', () => {
  it('separates evidence, partial and unknown cells', () => {
    const body = marked.replace('| A | 锁行。[S1] | 待实测 |', '| A | 锁行。[S1] | 部分覆盖。[S2] |');
    const matrix = parseComparisonMatrix(body);
    expect(matrix?.rows[0].option).toBe('A');
    expect(matrix?.dimensions).toEqual(['并发安全', '吞吐']);
    expect(matrix?.counts).toMatchObject({ evidence: 2, partial: 1, unknown: 1 });
  });

  it('returns null when the section is missing', () => {
    expect(parseComparisonMatrix('## 结论\n')).toBeNull();
  });
});

describe('findRecommendationLanguage', () => {
  it('leaves a compare-only artifact alone', () => {
    expect(findRecommendationLanguage(marked)).toEqual([]);
  });

  it('catches a winner sentence but not its negation', () => {
    const body = '## 对比结论\n\n建议选择 A，因为证据更多。\n\n不建议选择 B。';
    expect(findRecommendationLanguage(body)).toHaveLength(1);
  });
});

describe('checkComparisonMatrix evidence detection', () => {
  it('keeps scanning after the first cited cell', () => {
    const body = '## 对比矩阵\n\n| 方案 | A | B | C |\n|---|---|---|---|\n| x | [S1] | [S2] | [S3] |';
    expect(checkComparisonMatrix(body).unmarked).toEqual([]);
  });
});
