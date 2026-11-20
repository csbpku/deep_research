import { describe, expect, it } from 'vitest';
import { publicationSummaryRequirement } from './research-publish-requirements';

describe('publicationSummaryRequirement', () => {
  it('requires the three report sections for a research report', () => {
    const result = publicationSummaryRequirement({ type: 'research', creationMethod: 'manual', body: 'x' });
    expect(result.kind).toBe('research');
    expect(result.missing).toEqual(['background', 'conclusion', 'risks']);
    expect(result.complete).toBe(false);
  });

  it('only requires the body for a knowledge card', () => {
    expect(publicationSummaryRequirement({ type: 'knowledge', body: 'note' }).complete).toBe(true);
  });

  it('only requires the body for an AI learning path', () => {
    const result = publicationSummaryRequirement({ type: 'research', creationMethod: 'ai_research', reportType: 'learning_path', body: '## 概念图' });
    expect(result.kind).toBe('learning_path');
    expect(result.complete).toBe(true);
  });

  it('still requires summaries for an AI research report', () => {
    const result = publicationSummaryRequirement({ type: 'research', creationMethod: 'ai_research', reportType: 'research_report', body: 'x' });
    expect(result.kind).toBe('research');
    expect(result.missingLabels).toContain('背景');
  });
});

describe('comparison matrix', () => {
  it('carries its own structure and only needs a body', () => {
    const requirement = publicationSummaryRequirement({
      creationMethod: 'ai_research', reportType: 'comparison_matrix', body: '# 对比结论', background: '', conclusion: '', risks: '',
    });
    expect(requirement.kind).toBe('comparison_matrix');
    expect(requirement.required).toEqual(['body']);
    expect(requirement.complete).toBe(true);
  });
});
