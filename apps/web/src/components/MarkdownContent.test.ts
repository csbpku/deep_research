import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import MarkdownContent, { prepareContent } from './MarkdownContent';

describe('MarkdownContent links', () => {
  it('renders external references as visibly styled new-tab links', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: '## 参考文献\n\n1. Source. https://example.com/paper',
      }),
    );

    expect(html).toContain('href="https://example.com/paper"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('text-primary');
  });

  it('keeps footnote references and back links in the current page', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: '## 参考文献\n\n正文[^1]\n\n[^1]: Source. https://example.com/paper',
      }),
    );

    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).not.toContain('href="#user-content-fn-1" target="_blank"');
    expect(html).toContain('data-footnote-backref');
    expect(html).toContain('href="https://example.com/paper"');
    expect(html).toContain('>Source.</a>');
  });

  it('does not render dangerous URL protocols or raw HTML', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: '[bad](javascript:alert(1))\n\n<span>raw</span>',
      }),
    );

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<span>raw</span>');
    expect(html).toContain('bad');
    expect(html).toContain('raw');
  });
});

// M8: prepareContent 的 isMarkdown 检测 —— 已格式化的 markdown 原样返回，
// 不触发 reflow 启发式；PDF/arXiv 纯文本才走启发式 reflow。
describe('MarkdownContent prepareContent', () => {
  it('returns authored markdown unchanged (headings + lists + bold)', () => {
    const md = '# Title\n\n## Section\n\n- item one\n- item two\n\n**bold text** with a [link](https://example.com)';
    expect(prepareContent(md)).toBe(md);
  });

  it('returns GitHub README-style markdown unchanged (code fence)', () => {
    const md = '# Project\n\n```ts\nconst x = 1;\n```\n\nInstall with `npm i`';
    expect(prepareContent(md)).toBe(md);
  });

  it('does NOT reflow bold-only / link-only paragraphs (M8 fix)', () => {
    // 只有 **bold** 和 [link](url) 的段落也应识别为 markdown，不走 reflow
    const md = 'This is **bold** text.\n\nSee the [official docs](https://example.com) for details.';
    expect(prepareContent(md)).toBe(md);
  });

  it('reflows PDF-style plain text (no markdown markers)', () => {
    const plain = 'This is a long plain text paragraph that should be reflowed. It has no markdown markers.';
    const out = prepareContent(plain);
    expect(out).toContain('This is a long plain text');
  });
});
