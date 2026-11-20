import { describe, expect, it } from 'vitest';
import { cleanResearchArtifact, cleanLearningArtifact } from './research-artifact-cleanup';

describe('cleanLearningArtifact', () => {
  it('drops a trailing bibliography without touching earlier sections', () => {
    const body = '## 自检\n\n1. 问题\n\n## 参考文献\n\n1. [文档](https://pg)';
    expect(cleanLearningArtifact(body)).toBe('## 自检\n\n1. 问题');
  });

  it('keeps a mention of 参考文献 that is not a heading', () => {
    const body = '## 自检\n\n这节不需要参考文献。';
    expect(cleanLearningArtifact(body)).toContain('不需要参考文献');
  });
});


describe('cleanResearchArtifact', () => {
  it('only strips a bibliography from learning paths', () => {
    const body = '## 自检\n\n1. 问题\n\n## 参考文献\n\n1. [文档](https://pg)';
    expect(cleanResearchArtifact({ reportType: 'learning_path', body })).toBe('## 自检\n\n1. 问题');
    expect(cleanResearchArtifact({ reportType: 'research_report', body })).toBe(body);
    expect(cleanResearchArtifact({ reportType: null, body })).toBe(body);
  });
});
