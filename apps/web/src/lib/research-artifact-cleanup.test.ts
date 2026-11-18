import { describe, expect, it } from 'vitest';
import { cleanLearningArtifact } from './research-artifact-cleanup';

describe('cleanLearningArtifact', () => {
  it('drops the truncation note without leaving a gap', () => {
    const body = '## 分层解释\n正文。\n\n（这一节已压缩到字数上限；完整依据见参考来源。）\n\n## 自检\n问题。';
    expect(cleanLearningArtifact(body)).toBe('## 分层解释\n正文。\n\n## 自检\n问题。');
  });

  it('turns full citation links into compact tags', () => {
    expect(cleanLearningArtifact('事实。[S2](https://example.com/a) [S3](https://example.com/b)')).toBe(
      '事实。[S2] [S3]',
    );
  });
});
