import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ pending: false }));
vi.mock('next/link', () => ({ useLinkStatus: () => state }));
import { LinkPendingIcon } from './LinkPendingIcon';

beforeEach(() => { state.pending = false; });
const render = () => renderToStaticMarkup(h(LinkPendingIcon, { label: '技术专题', children: h('svg', { 'aria-hidden': true, 'data-idle-icon': true }) }));

describe('router-owned navigation feedback', () => {
  it('preserves the ordinary icon with no competing status while idle', () => {
    const html = render();
    expect(html).toContain('data-idle-icon');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('CircularProgress');
  });
  it('replaces only the fixed icon slot with contextual accessible progress while pending', () => {
    state.pending = true;
    const html = render();
    expect(html).not.toContain('data-idle-icon');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="正在加载技术专题"');
    expect(html).toContain('MuiCircularProgress-root');
    expect(html).not.toMatch(/<button|<a |disabled=/);
  });
  it('restores its normal icon immediately when the router stops pending', () => {
    state.pending = true;
    render();
    state.pending = false;
    expect(render()).toContain('data-idle-icon');
    expect(render()).not.toContain('role="status"');
  });
});
