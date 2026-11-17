import { describe, expect, it } from 'vitest';
import { checkLearningPath } from './research-learning-path';

const body = `# 学习

## 90 秒回答
回答。[S1]

## 概念图

| 概念 | 含义 | 关系 |
|---|---|---|
| A | a | 指向 B [S1] |
| B | b | 被 A 引用 [S1] |
| C | c | 与 A 并列 [S1] |
| D | d | 依赖 C [S1] |

## 分层解释
解释。[S1]

## 可运行示例
示例。

## 常见误区
误区。

## 自检
问题。
`;

describe('checkLearningPath', () => {
  it('accepts a complete path', () => {
    expect(checkLearningPath(body)).toMatchObject({ present: true, concepts: 4, issues: [] });
  });

  it('flags fewer than four concepts and a missing relation', () => {
    const short = body.replace(/\| [CD] \|[^\n]*\n/gu, '').replace('指向 B [S1]', '');
    const check = checkLearningPath(short);
    expect(check.issues.some(issue => issue.includes('4–6 个概念'))).toBe(true);
    expect(check.issues.some(issue => issue.includes('关系'))).toBe(true);
  });

  it('returns absent outside a learning path', () => {
    expect(checkLearningPath('# 报告\n\n## 结论\n')).toEqual({ present: false, concepts: 0, issues: [] });
  });
});
