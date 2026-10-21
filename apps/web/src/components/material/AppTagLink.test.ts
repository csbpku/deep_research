import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { BookOpenCheck } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { AppTagLink } from './AppTagLink';

describe('AppTagLink', () => {
  it('keeps the decorative icon beside the first label line and preserves long text wrapping', () => {
    const html = render(h(AppTagLink, {
      href: '/topics/model-context',
      label: '模型上下文与长文本推理专题名称',
      icon: h(BookOpenCheck, { 'aria-hidden': true }),
    }));
    const markup = html.slice(html.lastIndexOf('</style>') + '</style>'.length);

    expect(html).toContain('href="/topics/model-context"');
    expect(markup).toContain('模型上下文与长文本推理专题名称');
    expect(html).toContain('grid-template-columns:14px minmax(0, 1fr)');
    expect(markup).toContain('data-app-tag-content="with-icon"');
    expect(markup).toContain('data-app-tag-icon="true" aria-hidden="true"');
    expect(markup.indexOf('data-app-tag-icon="true"')).toBeLessThan(markup.indexOf('data-app-tag-text="true"'));
    expect(html).toContain('height:1.5em');
    expect(html).toContain('align-items:center');
    expect(html).not.toContain('padding-top:3px');
    expect(html).toContain('overflow-wrap:anywhere');
  });

  it('renders plain text labels without reserving an icon column', () => {
    const html = render(h(AppTagLink, { href: '/topics/ai', label: '人工智能' }));
    const markup = html.slice(html.lastIndexOf('</style>') + '</style>'.length);

    expect(markup).toContain('人工智能');
    expect(markup).not.toContain('data-app-tag-content');
    expect(markup).not.toContain('data-app-tag-icon');
  });
});
