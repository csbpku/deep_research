import { describe, expect, it } from 'vitest';

import { inferDecisionDimensions } from './research-plan-semantics';

describe('inferDecisionDimensions', () => {
  it('keeps explicit signals when the question names them', () => {
    expect(inferDecisionDimensions('比较两个队列的吞吐和部署成本')).toEqual(['成本与资源', '网络/性能实测', '部署与构建']);
  });

  it('proposes trade-off dimensions for a bare comparison', () => {
    expect(inferDecisionDimensions('比较 A 与 B', '', ['A', 'B'])).toEqual([
      '效果与适用范围',
      '安全与风险',
      '可运维性',
    ]);
  });

  it('stays with the two defaults when nothing is being compared', () => {
    expect(inferDecisionDimensions('是否引入缓存')).toEqual(['效果与适用范围', '安全与风险']);
  });

  it('widens a one-signal comparison to three dimensions', () => {
    expect(inferDecisionDimensions('比较 A 与 B 的适用边界', '', ['A', 'B'])).toEqual([
      '效果与适用范围',
      '安全与风险',
      '可运维性',
    ]);
  });

  it('never widens back into an excluded dimension', () => {
    expect(inferDecisionDimensions('比较 A 和 B，不讨论安全风险', '', ['A', 'B'])).toEqual([
      '效果与适用范围',
      '可运维性',
    ]);
  });
});
