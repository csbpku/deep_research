import { describe, expect, it } from 'vitest';
import { checkLearningPath } from './research-learning-path';

const body = `# 学习

## 90 秒回答
回答。[S1]

## 概念图

| 概念 | 含义 | 关系 |
|---|---|---|
| 事务 | 一次操作 | 指向快照 [S1] |
| 快照 | 可见性边界 | 被事务读取 [S1] |
| 行版本 | 元组历史 | 与快照比较 [S1] |
| 清理 | 回收空间 | 依赖快照 [S1] |

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
    const short = body.replace(/\| (行版本|清理) \|[^\n]*\n/gu, '').replace('指向快照 [S1]', '');
    const check = checkLearningPath(short);
    expect(check.issues.some(issue => issue.includes('4–6 个概念'))).toBe(true);
    expect(check.issues.some(issue => issue.includes('关系'))).toBe(true);
  });

  it('flags a learning path with no concept map instead of passing it', () => {
    expect(checkLearningPath('# 报告\n\n## 结论\n')).toEqual({
      present: false,
      concepts: 0,
      issues: ['缺少「## 概念图」章节'],
    });
  });
});

describe('checkLearningPath semantic relations', () => {
  it('rejects a generic relation such as 相关', () => {
    const odd = body.replace('指向快照 [S1]', '相关');
    const check = checkLearningPath(odd);
    expect(check.issues.some(issue => issue.includes('过于笼统'))).toBe(true);
  });

  it('accepts a relation that names another concept directly', () => {
    expect(checkLearningPath(body).issues).toEqual([]);
  });
});
