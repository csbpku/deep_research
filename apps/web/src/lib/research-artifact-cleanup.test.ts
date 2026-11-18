import { describe, expect, it } from 'vitest';
import { cleanLearningArtifact } from './research-artifact-cleanup';

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
