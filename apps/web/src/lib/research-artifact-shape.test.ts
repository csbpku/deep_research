import { describe, expect, it } from 'vitest';
import { hasOwnArtifactContract, shouldRenderResearchSummary } from './research-artifact-shape';

describe('research artifact shape', () => {
  it('treats decision memos, learning paths and comparison matrices as self-contained', () => {
    expect(hasOwnArtifactContract({ type: 'research', body: '# 决策备忘\n\n## 建议' })).toBe(true);
    expect(hasOwnArtifactContract({ type: 'research', reportType: 'learning_path', body: '# 学习' })).toBe(true);
    expect(hasOwnArtifactContract({ type: 'research', reportType: 'comparison_matrix', body: '# 对比' })).toBe(true);
  });

  it('recognises an intent report by its first contract heading', () => {
    expect(hasOwnArtifactContract({ type: 'research', body: '## 现象与范围\n\n...' })).toBe(true);
    expect(hasOwnArtifactContract({ type: 'research', body: '## 一句话回答\n\n...' })).toBe(true);
    expect(hasOwnArtifactContract({ type: 'research', body: '# 机制分析\n\n## 现象与范围\n\n...' })).toBe(true);
  });

  it('does not suppress a plain long research report or a knowledge card', () => {
    expect(hasOwnArtifactContract({ type: 'research', body: '# 研究稿\n\n## 背景' })).toBe(false);
    expect(hasOwnArtifactContract({ type: 'knowledge', body: '# 决策备忘' })).toBe(false);
  });

  it('only renders the generic summary when the summary exists and the artifact has no contract', () => {
    expect(shouldRenderResearchSummary({ type: 'research', body: '# 研究稿' }, { conclusion: '结论' })).toBe(true);
    expect(shouldRenderResearchSummary({ type: 'research', body: '# 决策备忘' }, { conclusion: '结论' })).toBe(false);
    expect(shouldRenderResearchSummary({ type: 'research', body: '# 研究稿' }, {})).toBe(false);
  });
});

describe('opening heading only', () => {
  it('does not treat a quoted heading deeper in a normal report as the artifact contract', () => {
    expect(hasOwnArtifactContract({ type: 'research', body: '# 研究稿\n\n正文\n\n## 建议\n\n摘录' })).toBe(false);
  });
});
