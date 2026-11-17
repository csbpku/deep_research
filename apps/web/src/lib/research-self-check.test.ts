import { describe, expect, it } from 'vitest';
import { parseSelfCheck, stripSelfCheckSection } from './research-self-check';

const body = `# 学习

## 自检

1. **什么是快照？** 答案要点：某一时刻的事务状态集合。[S1](https://example.com)
2. 为什么需要 xmax？

答案：标记删除或替换的事务。

## 参考文献
`;

describe('parseSelfCheck', () => {
  it('parses inline and next-line answers', () => {
    const items = parseSelfCheck(body);
    expect(items).toHaveLength(2);
    expect(items[0].question).toBe('什么是快照？');
    expect(items[0].answer).toContain('事务状态集合');
    expect(items[1].answer).toContain('标记删除');
  });

  it('returns nothing outside a learning path', () => {
    expect(parseSelfCheck('## 结论\n\n1. 不是自检')).toEqual([]);
  });
});

describe('stripSelfCheckSection', () => {
  it('removes only the self-check section', () => {
    expect(stripSelfCheckSection(body)).toContain('## 参考文献');
    expect(stripSelfCheckSection(body)).not.toContain('答案要点');
  });
});
