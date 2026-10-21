import React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReaderPublicDocument } from './ReaderPublicDocument';

describe('ReaderPublicDocument', () => {
  it('preserves semantic headings, reader navigation, and external support destination', () => {
    const html = render(h(ReaderPublicDocument, {
      title: '使用与支持',
      intro: '在原网页阅读，在侧栏讨论。',
      children: h('section', null, h('h2', null, '开始阅读'), h('p', null, '安装后打开侧栏。')),
    }));

    expect(html).toContain('<article');
    expect(html).toMatch(/<h1[^>]*>使用与支持<\/h1>/);
    expect(html).toContain('<h2>开始阅读</h2>');
    expect(html).toContain('安装 Reader');
    expect(html).toContain('href="/reading/privacy?lang=zh-CN"');
    expect(html).toContain('href="/reading/support?lang=zh-CN"');
    expect(html).toContain('href="https://github.com/csbpku/deep_research/issues"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });
});
