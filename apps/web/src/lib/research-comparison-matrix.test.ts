import { describe, expect, it } from 'vitest';

import { checkComparisonMatrix, parseComparisonMatrix } from './research-comparison-matrix';

const MATRIX = `# 对比结论

## 对比矩阵

| 候选方案 | 死锁 | 复杂度 |
|---|---|---|
| A | **有证据**：多锁需统一顺序 [S1] | **有证据**：需设计确定性键 [S2] |
| B | **有证据**：行锁可参与死锁 [S2][S3] | **未找到**：本轮未确认 |

> **证据边界说明**

| 未知或冲突项 | 原因 |
|---|---|
| 池占用 | 未实测 |
`;

describe('parseComparisonMatrix', () => {
  it('keeps only the matrix table when a note table follows it', () => {
    const matrix = parseComparisonMatrix(MATRIX);
    expect(matrix?.dimensions).toEqual(['死锁', '复杂度']);
    expect(matrix?.rows).toHaveLength(2);
    expect(matrix?.rows[0].cells.map(cell => cell.status)).toEqual(['evidence', 'evidence']);
    expect(matrix?.rows[1].cells[1].status).toBe('unknown');
  });

  it('checks only the matrix cells for evidence markers', () => {
    const check = checkComparisonMatrix(MATRIX);
    expect(check.columns).toBe(2);
    expect(check.unmarked).toEqual([]);
  });

  it('returns null when the section has no table at all', () => {
    expect(parseComparisonMatrix('## 对比矩阵\n\n没有表。')).toBeNull();
  });
});
