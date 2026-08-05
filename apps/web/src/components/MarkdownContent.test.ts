import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import MarkdownContent from './MarkdownContent';

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
});
