import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SelectionActionWindow } from './SelectionActionWindow';


describe('SelectionActionWindow', () => {
  it('renders a movable, resizable result window without prompt diagnostics', () => {
    const html = renderToStaticMarkup(createElement(SelectionActionWindow, {
      title: '解释选中内容',
      initialPosition: { top: 100, left: 120 },
      placementKey: 'selection-1',
      onClose: vi.fn(),
      children: createElement('p', null, '解释结果'),
    }));

    expect(html).toContain('解释选中内容');
    expect(html).toContain('调整窗口大小');
    expect(html).toContain('解释结果');
    expect(html).not.toContain('查看发送给 AI 的内容');
  });
});
