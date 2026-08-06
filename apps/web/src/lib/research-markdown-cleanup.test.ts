import { describe, expect, it } from 'vitest';

import { cleanResearchMarkdown } from './research-markdown-cleanup';

describe('cleanResearchMarkdown', () => {
  it('removes persisted browser-wrapper reference list items', () => {
    expect(cleanResearchMarkdown('# 报告\n\n1. ：goto (/goto?url=token)\n\n正文')).toBe('# 报告\n\n正文');
  });

  it('keeps normal markdown references', () => {
    expect(cleanResearchMarkdown('## 参考文献\n\n1. ：goto (/goto?url=token)\n6. [官方文档](https://example.com/docs)')).toBe('## 参考文献\n\n1. [官方文档](https://example.com/docs)');
  });
});
