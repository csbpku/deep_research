import { describe, expect, it } from 'vitest';

import {
  cleanResearchLabel,
  cleanResearchMarkdown,
  cleanResearchText,
} from './research-markdown-cleanup';

describe('cleanResearchMarkdown', () => {
  it('removes persisted browser-wrapper reference list items', () => {
    expect(cleanResearchMarkdown('# 报告\n\n1. ：goto (/goto?url=token)\n\n正文')).toBe('# 报告\n\n正文');
  });

  it('keeps normal markdown references', () => {
    expect(cleanResearchMarkdown('## 参考文献\n\n1. ：goto (/goto?url=token)\n6. [官方文档](https://example.com/docs)')).toBe('## 参考文献\n\n1. [官方文档](https://example.com/docs)');
  });

  it('removes persisted non-breaking-space entities', () => {
    expect(cleanResearchMarkdown('Background&nbsp;|&nbsp;Gemini\n\n正文')).toBe('Background | Gemini\n\n正文');
    expect(cleanResearchLabel('Claude&nbsp;&nbsp;Research')).toBe('Claude Research');
  });

  it('decodes named and numeric entities left by HTML extraction', () => {
    expect(cleanResearchMarkdown('A &amp; B &quot;quoted&quot; &#39;yes&#39; &#x2014; / &8212; done')).toBe(
      'A & B "quoted" \'yes\' — / — done',
    );
    expect(cleanResearchText('第一行&nbsp;\n第二行 &middot; 第二列')).toBe(
      '第一行 \n第二行 · 第二列',
    );
  });
});
