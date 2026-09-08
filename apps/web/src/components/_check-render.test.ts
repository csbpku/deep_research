import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import MarkdownContent from './MarkdownContent';

const samples: Array<[string, string]> = [
  ['footnote ref inside link', '[Some [reference](#user-content-fn-1) text](https://example.com)'],
  ['img then link', '![alt](https://example.com/img.png) text [link](https://example.com/page)'],
  ['link with bold', '[**bold text**](https://example.com)'],
  ['link with italic', '[*italic text*](https://example.com)'],
  ['link with code', '[`code`](https://example.com)'],
  ['empty link', '[](https://example.com)'],
];

describe('nested anchor detection', () => {
  it.each(samples)('renders %s without nesting', (_label, md) => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: md }));
    console.log('\n=== %s ===', _label);
    console.log('input:', md);
    console.log('output:', html);
    // Naive check: find any <a> whose content includes another <a>
    // Use simple regex that handles a single nested a level
    expect(html).not.toMatch(/<a[^>]*>(?:(?!<\/?a\b).)*<a[\s>]/u);
  });
});
