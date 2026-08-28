import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MarkdownPreview } from './MarkdownPreview';

describe('MarkdownPreview', () => {
  it('uses the shared renderer for headings, GFM tables and code blocks', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        source: '# Title\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```ts\nconst value = 1;\n```',
      }),
    );

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<table>');
    // 共享渲染器对代码块做 highlight.js 高亮，纯文本被拆进 span
    expect(html).toContain('class="hljs language-ts"');
    expect(html).toContain('value');
  });

  it('does not render unsafe HTML or URL protocols', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        source: '[bad](javascript:alert(1))\n\n<script>alert(1)</script>',
      }),
    );

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script>');
    expect(html).toContain('bad');
  });
});
